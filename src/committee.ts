import { CommitteeData, CommitteeMember } from './types';
import { Client, Node } from '@orbs-network/client';
const LAMBDA_SCRIPT_BASE_URL = process.env.LAMBDA_SCRIPT_BASE_URL || 'service/vm-lambda/cmt-sync';
export class CommitteeFetcher {
  private client: Client;
  private lastCommittee: CommitteeData | null = null;

  constructor(client: Client) {
    this.client = client;
  }

  async getCurrentCommittee(): Promise<CommitteeData> {
    // Get committee nodes
    const nodes = await this.client.getNodes({ committeeOnly: true });

    if (nodes.size() === 0) {
      throw new Error('No committee nodes found');
    }

    // DEV_NODE_HOST exist, instantiate a new node with the DEV_NODE_HOST
    let node: Node | null = null;
    if (this.client.localNode) {
      node = this.client.localNode;
    } else {
      // Use the first node to fetch current committee
      node = nodes.get(0);
    }
    if (!node) {
      throw new Error('Failed to get committee node');
    }

    try {
      // Call the lambda endpoint to get current committee
      const response = await node.get(`${LAMBDA_SCRIPT_BASE_URL}/getCurrentCommittee`);

      if (!response.ok) {
        throw new Error(`Failed to fetch committee: HTTP ${response.status}`);
      }

      const data: any = await response.json();
      if (!data?.success) {
        throw new Error(`Failed to fetch committee: ${data?.error}`);
      }

      // Parse the response based on format in ignore/cur.comt.example.json
      const membersArray = data?.result?.members;
      if (!Array.isArray(membersArray)) {
        throw new Error('Invalid committee format: result.members must be an array');
      }

      const members: CommitteeMember[] = membersArray.map((member: any) => {
        const ethAddr = typeof member?.ethAddress === 'string' ? member.ethAddress : '';
        const orbsAddr = typeof member?.orbsAddress === 'string' ? member.orbsAddress : '';
        return {
          ...member,
          ethAddress: ethAddr.startsWith('0x') ? ethAddr : `0x${ethAddr}`,
          orbsAddress: orbsAddr.startsWith('0x') ? orbsAddr : `0x${orbsAddr}`,
        };
      });

      // empty array as config if not passed in result
      const config = Array.isArray(data?.result?.config) ? data.result.config : [];

      const committee: CommitteeData = {
        members,
        config,
        timestamp: Date.now(),
      };

      return committee;
    } catch (error) {
      throw new Error(`Error fetching committee: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  hasCommitteeChanged(newCommittee: CommitteeData): boolean {
    if (!this.lastCommittee) {
      return true;
    }

    // Compare committee member addresses by orbsAddress — that's what the on-chain
    // contract stores and verifies signatures against. A guardian rotating their orbs
    // key (same ethAddress, new orbsAddress) is intentionally treated as a cmt change,
    // since the contract must be re-synced to recognize the new signing key.
    const oldAddresses = this.lastCommittee.members
      .map(m => m.orbsAddress.toLowerCase())
      .sort();
    const newAddresses = newCommittee.members
      .map(m => m.orbsAddress.toLowerCase())
      .sort();

    if (oldAddresses.length !== newAddresses.length) {
      return true;
    }

    for (let i = 0; i < oldAddresses.length; i++) {
      if (oldAddresses[i] !== newAddresses[i]) {
        return true;
      }
    }

    return false;
  }

  setLastCommittee(committee: CommitteeData): void {
    this.lastCommittee = committee;
  }

  getLastCommittee(): CommitteeData | null {
    return this.lastCommittee;
  }

  /**
   * Enriches committee members with ip/port from orbs-client nodes.
   * Required before passing to collectSignatures (which uses only committee data).
   */
  async enrichCommitteeWithNodeInfo(committee: CommitteeData): Promise<CommitteeData> {
    const nodes = await this.client.getNodes({ committeeOnly: true });
    if (nodes.size() === 0) return committee;

    const nodeByOrbsAddress = new Map<string, Node>();
    let node = nodes.next();
    while (node !== null) {
      const addr = (node.nodeAddress || '').toLowerCase();
      const normalized = addr.startsWith('0x') ? addr : `0x${addr}`;
      if (addr) nodeByOrbsAddress.set(normalized, node);
      node = nodes.next();
    }

    const members: CommitteeMember[] = [];
    for (const m of committee.members) {
      const normalized = m.orbsAddress.toLowerCase().startsWith('0x')
        ? m.orbsAddress.toLowerCase()
        : `0x${m.orbsAddress.toLowerCase()}`;
      const n = nodeByOrbsAddress.get(normalized);
      const ip = n?.ip ?? m.ip;
      const port = n?.port ?? m.port ?? 80;
      if (!ip) {
        console.warn(`Skipping member ${m.orbsAddress} — no ip after enrichment`);
        continue;
      }
      members.push({ ...m, ip, port });
    }

    console.log(`Enriched ${members.length}/${committee.members.length} member(s) with node info`);
    return { ...committee, members };
  }
}

