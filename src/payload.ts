import { CommitteeMember } from './types';
import { Client, Node } from '@orbs-network/client';

const LAMBDA_SCRIPT_BASE_URL = process.env.LAMBDA_SCRIPT_BASE_URL || 'service/vm-lambda/cmt-sync';

function nodeFromLambdaEntry(entry: any): Node {
  return new Node({
    name: entry.name || '',
    ip: entry.ip || '',
    port: entry.port ?? 80,
    website: '',
    guardianAddress: entry.ethAddress || '',
    nodeAddress: entry.orbsAddress || '',
    reputation: 1,
    effectiveStake: 1,
    enterTime: 0,
    weight: 1,
    inCommittee: true,
    teeHardware: false,
  });
}

export class PayloadFetcher {
  private client: Client;
  private lastPayloadHash: string | null = null;
  /**
   * Cached list of committee nodes from the most recent getSyncHash response.
   * The lambda is the source of truth — it returns both the payload hash AND
   * who's in the committee, on every call.
   */
  private lastNodes: Node[] = [];

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Returns the nodes to call getSignedPayload on.
   *
   * Source: cached from the most recent getSyncHash response. If empty
   * (first call before any getSyncHash), triggers one to populate.
   */
  async getCommitteeNodes(): Promise<Node[]> {
    if (this.lastNodes.length === 0) {
      // Any nonce works here — we only care about the `nodes` field in the
      // response, which is nonce-independent. The hash we throw away.
      await this.getSyncHash(0);
    }
    return this.lastNodes;
  }

  /**
   * Pick a node to bootstrap from — used only when lastNodes cache is empty
   * (i.e. very first call). Subnet: localNode. Mainnet: random committee node.
   */
  private async getBootstrapNode(): Promise<Node> {
    if (this.client.localNode) {
      return this.client.localNode;
    }
    const nodes = await this.client.getNodes({ committeeOnly: true });
    if (nodes.size() === 0) {
      throw new Error('No bootstrap nodes available (orbs-client returned empty)');
    }
    const result: Node[] = [];
    let n = nodes.next();
    while (n !== null) {
      if (n.ip) result.push(n);
      n = nodes.next();
    }
    if (result.length === 0) {
      throw new Error('No bootstrap nodes have an IP');
    }
    return result[Math.floor(Math.random() * result.length)];
  }

  /**
   * Lightweight check: ask one node for the sync payload hash at `referenceNonce`.
   * Also caches the committee node list from the response — the lambda is
   * the single source of truth for both "did anything change" and "who's
   * in the committee".
   *
   * The lambda's hash is computed over (nonce, committee, config), so the
   * caller must pass the nonce they want to compare against. For change
   * detection, pass the latest synced nonce — if the hash differs from the
   * one stored at that nonce in DB, (committee, config) has changed.
   */
  async getSyncHash(referenceNonce: number): Promise<string> {
    // Prefer a cached node (from a previous getSyncHash response) — randomized
    // across calls so we don't always hit the same one. Bootstrap if cache empty.
    const pool = this.lastNodes.length > 0 ? this.lastNodes : [await this.getBootstrapNode()];
    const node = pool[Math.floor(Math.random() * pool.length)];
    console.log(`[getSyncHash] querying node ${node.nodeAddress || node.ip} at nonce=${referenceNonce}`);

    // 15s timeout (orbs-client default is 5s, occasionally too short for subnet nodes)
    const response = await node.get(`${LAMBDA_SCRIPT_BASE_URL}/getSyncHash?nonce=${referenceNonce}`, 15000);
    if (!response.ok) {
      throw new Error(`Failed to fetch sync hash: HTTP ${response.status}`);
    }

    const data: any = await response.json();
    if (!data?.success) {
      throw new Error(`Failed to fetch sync hash: ${data?.error}`);
    }

    const hash = data?.result?.payloadHash;
    if (typeof hash !== 'string' || !hash) {
      throw new Error('Invalid sync hash format in response');
    }

    // Cache committee nodes from this response (source of truth for collection).
    const nodes = data?.result?.nodes;
    if (Array.isArray(nodes) && nodes.length > 0) {
      this.lastNodes = nodes
        .filter((e: any) => e && typeof e.ip === 'string' && e.ip)
        .map(nodeFromLambdaEntry);
      console.log(`[getSyncHash] cached ${this.lastNodes.length} committee node(s)`);
    }

    return hash.startsWith('0x') ? hash : `0x${hash}`;
  }

  hasSyncPayloadChanged(newHash: string): boolean {
    const normalized = newHash.startsWith('0x') ? newHash.toLowerCase() : `0x${newHash.toLowerCase()}`;
    return this.lastPayloadHash !== normalized;
  }

  setLastPayloadHash(hash: string): void {
    // Normalize to 0x-prefixed lowercase so comparison with fresh hashes is consistent
    // (legacy DB rows may lack the 0x prefix from before the payload-hash refactor).
    const normalized = hash.startsWith('0x') ? hash.toLowerCase() : `0x${hash.toLowerCase()}`;
    this.lastPayloadHash = normalized;
  }

  getLastPayloadHash(): string | null {
    return this.lastPayloadHash;
  }

  /**
   * Looks up rich member info (name, ip, port, orbsAddress, ethAddress, etc.)
   * for a list of orbs addresses, from the orbs-client node directory.
   * Used when persisting a synced committee so the dashboard can show details.
   */
  async enrichAddressesWithMemberInfo(orbsAddresses: string[]): Promise<CommitteeMember[]> {
    const nodeByOrbsAddress = new Map<string, Node>();
    // Subnet mode: orbsClient.init() was skipped, so getNodes() can't be called.
    // Members get stored without rich info — dashboard will just show addresses.
    if (this.client.initialized()) {
      const nodes = await this.client.getNodes({ committeeOnly: false });
      let n = nodes.next();
      while (n !== null) {
        const addr = (n.nodeAddress || '').toLowerCase();
        const normalized = addr.startsWith('0x') ? addr : `0x${addr}`;
        if (addr) nodeByOrbsAddress.set(normalized, n);
        n = nodes.next();
      }
    }

    return orbsAddresses.map((orbsAddress) => {
      const normalized = orbsAddress.toLowerCase().startsWith('0x')
        ? orbsAddress.toLowerCase()
        : `0x${orbsAddress.toLowerCase()}`;
      const node = nodeByOrbsAddress.get(normalized);
      return {
        orbsAddress: normalized,
        ethAddress: node?.guardianAddress
          ? (node.guardianAddress.startsWith('0x') ? node.guardianAddress : `0x${node.guardianAddress}`)
          : '',
        ip: node?.ip,
        port: node?.port ?? 80,
        name: node?.name,
        weight: node?.weight,
        effectiveStake: node?.effectiveStake,
      } as CommitteeMember;
    });
  }
}
