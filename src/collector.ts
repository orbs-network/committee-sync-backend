import { CommitteeSyncConfigItem, SignatureData } from './types';
import { Node } from '@orbs-network/client';

// Minimum number of guardians that must agree on the same payloadHash.
// Defaults to 3 (mainnet). In subnet mode with a single guardian, set MIN_VOTERS=1.
const MIN_VOTERS = parseInt(process.env.MIN_VOTERS || '3', 10);
const LAMBDA_SCRIPT_BASE_URL =
  process.env.LAMBDA_SCRIPT_BASE_URL || 'service/vm-lambda/cmt-sync';

/**
 * A signed sync payload returned by one guardian:
 * - committee: the committee addresses the guardian sees
 * - config: per-address config the guardian sees
 * - payloadHash: hash over (committee, config) — must match what we submit
 * - signature: ECDSA signature over the EIP-712 digest for (nonce, committee, config)
 * - signerOrbsAddress: the orbs address of the guardian that signed
 */
export interface SignedPayload {
  committee: string[];
  /** Rich, human-readable per-entry config — for DB / dashboard. */
  config: CommitteeSyncConfigItem[];
  /** Wire format: tuples [bytes32 key, address account, bytes value] — what we send to sync(). */
  configEncoded: Array<[string, string, string]>;
  payloadHash: string;
  signature: string;
  signerOrbsAddress: string;
}

/**
 * Result of validating a set of signed payloads: the majority group's
 * agreed-upon committee + config + hash, plus all sigs from that group.
 */
export interface ValidatedSyncPayload {
  committee: string[];
  config: CommitteeSyncConfigItem[];
  configEncoded: Array<[string, string, string]>;
  payloadHash: string;
  signatures: SignatureData[];
}

/**
 * Groups signed payloads by payloadHash, takes the majority group,
 * and returns it only if its size >= MIN_VOTERS. Otherwise throws.
 *
 * The majority group is the source of truth: its members agree on
 * committee+config, so we use those values to build the TX.
 */
export function validateSignedPayloads(payloads: SignedPayload[]): ValidatedSyncPayload {
  const groups = new Map<string, SignedPayload[]>();

  for (const p of payloads) {
    const hash = p.payloadHash ?? 'unknown';
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash)!.push(p);
  }

  // Find the majority group (largest)
  let majorityHash = '';
  let majorityGroup: SignedPayload[] = [];
  for (const [hash, ps] of groups) {
    if (ps.length > majorityGroup.length) {
      majorityHash = hash;
      majorityGroup = ps;
    }
  }

  const groupSummary = [...groups.entries()]
    .map(([hash, ps]) => `${hash.slice(0, 10)}...=${ps.length}`)
    .join(', ');
  console.log(`Signed payload voter groups: [${groupSummary}]`);

  if (groups.size > 1) {
    const discarded = payloads.length - majorityGroup.length;
    console.warn(
      `Payload hash mismatch: ${groups.size} different hashes seen. ` +
      `Using majority group ${majorityHash.slice(0, 10)}... (${majorityGroup.length} payload(s)), ` +
      `discarding ${discarded} from minority group(s).`
    );
  }

  if (majorityGroup.length < MIN_VOTERS) {
    throw new Error(
      `Insufficient consensus: majority group has ${majorityGroup.length} payload(s) ` +
      `but minimum is ${MIN_VOTERS}. Groups: [${groupSummary}]`
    );
  }

  // All members of the majority agree, so use the first one's committee+config
  const ref = majorityGroup[0];
  return {
    committee: ref.committee,
    config: ref.config,
    configEncoded: ref.configEncoded,
    payloadHash: ref.payloadHash,
    signatures: majorityGroup.map((p) => ({
      signature: p.signature,
      orbsAddress: p.signerOrbsAddress,
      committeeHash: p.payloadHash,
    })),
  };
}

function buildServiceUrl(node: Node, path: string): string {
  if (!node.ip) {
    throw new Error(`Node ${node.nodeAddress} has no ip - cannot fetch payload`);
  }
  const port = node.port ?? 80;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const portPart = port === 0 ? '' : `:${port}`;
  return `http://${node.ip}${portPart}/services${normalizedPath}`;
}

export class SignatureCollector {
  /**
   * Calls getSignedPayload on each committee node. Returns the signed payloads
   * (committee, config, hash, signature) from those that responded successfully.
   * The caller then validates consensus across them.
   */
  async collectSignedPayloads(nodes: Node[], nonce: number): Promise<SignedPayload[]> {
    if (!nodes.length) {
      throw new Error('No nodes to collect signed payloads from');
    }

    const promises = nodes.map((node) => this.fetchSignedPayload(node, nonce));
    const results = await Promise.allSettled(promises);

    const payloads: SignedPayload[] = [];
    const errors: Array<{ node: string; error: string }> = [];

    results.forEach((result, i) => {
      const node = nodes[i];
      if (result.status === 'fulfilled') {
        payloads.push(result.value);
      } else {
        errors.push({
          node: node?.nodeAddress ?? node?.ip ?? 'unknown',
          error: result.reason?.message ?? String(result.reason),
        });
      }
    });

    if (errors.length > 0) {
      console.warn(`Failed to collect signed payload from ${errors.length} node(s):`, errors);
    }

    if (payloads.length === 0) {
      throw new Error('Failed to collect any signed payloads from committee nodes');
    }

    return payloads;
  }

  private async fetchSignedPayload(node: Node, nonce: number): Promise<SignedPayload> {
    const url = buildServiceUrl(
      node,
      `${LAMBDA_SCRIPT_BASE_URL}/getSignedPayload?nonce=${nonce}`
    );

    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: any = await response.json();
    if (data?.success === false && data?.error) {
      throw new Error(`Lambda error: ${data.error}`);
    }

    const result = data?.result;
    if (!result) {
      throw new Error('Invalid response: missing result');
    }

    const signature = result.signature;
    if (typeof signature !== 'string' || !signature) {
      throw new Error('Invalid signature in response');
    }

    const payloadHash = result.payloadHash;
    if (typeof payloadHash !== 'string' || !payloadHash) {
      throw new Error('Invalid payloadHash in response');
    }

    if (!Array.isArray(result.committee)) {
      throw new Error('Invalid committee in response: must be an array');
    }

    const config = Array.isArray(result.config) ? result.config : [];
    const configEncoded = Array.isArray(result.configEncoded) ? result.configEncoded : [];

    const signerOrbsAddress = (node.nodeAddress || '').toLowerCase();
    const normalizedSigner = signerOrbsAddress.startsWith('0x')
      ? signerOrbsAddress
      : `0x${signerOrbsAddress}`;

    return {
      committee: result.committee.map((a: string) =>
        a.startsWith('0x') ? a : `0x${a}`
      ),
      config,
      configEncoded,
      payloadHash: payloadHash.startsWith('0x') ? payloadHash : `0x${payloadHash}`,
      signature: signature.startsWith('0x') ? signature : `0x${signature}`,
      signerOrbsAddress: normalizedSigner,
    };
  }
}
