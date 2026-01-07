import { CommitteeData, CommitteeMember } from './types';
import { Client } from '@orbs-network/orbs-client';

export class CommitteeFetcher {
  private client: Client;
  private lastCommittee: CommitteeData | null = null;

  constructor(seedIP: string) {
    this.client = new Client(seedIP);
  }

  async init(): Promise<void> {
    await this.client.init();
    if (!this.client.initialized()) {
      throw new Error('Failed to initialize ORBS client');
    }
  }

  async getCurrentCommittee(): Promise<CommitteeData> {
    // Get committee nodes
    const nodes = await this.client.getNodes({ committeeOnly: true });

    if (nodes.size() === 0) {
      throw new Error('No committee nodes found');
    }

    // Use the first node to fetch current committee
    const node = nodes.get(0);
    if (!node) {
      throw new Error('Failed to get committee node');
    }

    try {
      // Call the lambda endpoint to get current committee
      const response = await node.get('vm-lambda/cmt-sync/getCurrentCommittee');

      if (!response.ok) {
        throw new Error(`Failed to fetch committee: HTTP ${response.status}`);
      }

      const data: any = await response.json();

      // Parse the response - adjust based on actual API response format
      // Assuming the response contains committee members
      const members: CommitteeMember[] = Array.isArray(data)
        ? data.map((member: any) => ({
          address: typeof member === 'string' ? member : member.address || member.guardianAddress,
          ...member
        }))
        : (data.committee || data.members || []).map((member: any) => ({
          address: typeof member === 'string' ? member : member.address || member.guardianAddress,
          ...member
        }));

      const committee: CommitteeData = {
        members,
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

    // Compare committee member addresses
    const oldAddresses = this.lastCommittee.members
      .map(m => m.address.toLowerCase())
      .sort();
    const newAddresses = newCommittee.members
      .map(m => m.address.toLowerCase())
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
}

