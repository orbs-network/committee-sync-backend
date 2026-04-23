import { CommitteeData, CommitteeMember, SignatureData } from './types';

const MIN_VOTERS = 3;

/**
 * Validates that collected signatures agree on the same committeeHash.
 * Groups signatures by committeeHash, takes the majority group, and
 * returns it only if its size >= MIN_VOTERS. Otherwise throws.
 *
 * This prevents submitting a TX with signatures that were signed over
 * different committee views (e.g. during node propagation delays).
 */
export function validateSignatureVoters(signatures: SignatureData[]): SignatureData[] {
  const groups = new Map<string, SignatureData[]>();

  for (const sig of signatures) {
    const hash = sig.committeeHash ?? 'unknown';
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash)!.push(sig);
  }

  // Find the majority group (largest)
  let majorityHash = '';
  let majorityGroup: SignatureData[] = [];
  for (const [hash, sigs] of groups) {
    if (sigs.length > majorityGroup.length) {
      majorityHash = hash;
      majorityGroup = sigs;
    }
  }

  // Log all groups for traceability
  const groupSummary = [...groups.entries()]
    .map(([hash, sigs]) => `${hash.slice(0, 10)}...=${sigs.length} sig(s)`)
    .join(', ');
  console.log(`Signature voter groups: [${groupSummary}]`);

  if (groups.size > 1) {
    const discarded = signatures.length - majorityGroup.length;
    console.warn(
      `Committee hash mismatch: ${groups.size} different hashes seen. ` +
      `Using majority group ${majorityHash.slice(0, 10)}... (${majorityGroup.length} sig(s)), ` +
      `discarding ${discarded} sig(s) from minority group(s).`
    );
  }

  if (majorityGroup.length < MIN_VOTERS) {
    throw new Error(
      `Insufficient signature consensus: majority group has ${majorityGroup.length} sig(s) ` +
      `but minimum is ${MIN_VOTERS}. Groups: [${groupSummary}]`
    );
  }

  return majorityGroup;
}

const LAMBDA_SCRIPT_BASE_URL =
  process.env.LAMBDA_SCRIPT_BASE_URL || 'service/vm-lambda/cmt-sync';

function buildServiceUrl(member: CommitteeMember, path: string): string {
  const ip = member.ip;
  const port = member.port ?? 80;
  if (!ip) {
    throw new Error(
      `Committee member ${member.orbsAddress} has no ip - cannot fetch signature`
    );
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const portPart = port === 0 ? '' : `:${port}`;
  return `http://${ip}${portPart}/services${normalizedPath}`;
}

export class SignatureCollector {
  /**
   * Collect signatures from committee members for the given nonce.
   * Uses only the committee data passed in - each member must have ip (and optionally port)
   * to make HTTP requests to getSignedCommittee.
   */
  async collectSignatures(
    committee: CommitteeData,
    nonce: number
  ): Promise<SignatureData[]> {
    if (!committee.members?.length) {
      throw new Error('No committee members to collect signatures from');
    }

    const promises = committee.members.map((member) =>
      this.fetchSignatureFromMember(member, nonce)
    );

    const results = await Promise.allSettled(promises);
    return this.collectResults(results, committee.members);
  }

  private async fetchSignatureFromMember(
    member: CommitteeMember,
    nonce: number
  ): Promise<SignatureData> {
    const url = buildServiceUrl(
      member,
      `${LAMBDA_SCRIPT_BASE_URL}/getSignedCommittee?nonce=${nonce}`
    );

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: any = await response.json();
    if (data?.success === false && data?.error) {
      throw new Error(`Lambda error: ${data.error}`);
    }

    const signature = data?.result?.signature;
    if (!signature || typeof signature !== 'string') {
      throw new Error('Invalid signature format in response');
    }

    const committeeHash = data?.result?.committeeHash;

    const addr =
      member.orbsAddress.startsWith('0x') ? member.orbsAddress : `0x${member.orbsAddress}`;
    return {
      signature: signature.startsWith('0x') ? signature : `0x${signature}`,
      orbsAddress: addr,
      committeeHash: typeof committeeHash === 'string' ? committeeHash : undefined,
    };
  }

  private collectResults(
    results: PromiseSettledResult<SignatureData>[],
    members: CommitteeMember[]
  ): SignatureData[] {
    const signatures: SignatureData[] = [];
    const errors: Array<{ member: string; error: string }> = [];

    results.forEach((result, i) => {
      const member = members[i];
      if (result.status === 'fulfilled') {
        signatures.push(result.value);
      } else {
        errors.push({
          member: member?.orbsAddress ?? 'unknown',
          error: result.reason?.message ?? String(result.reason),
        });
      }
    });

    if (errors.length > 0) {
      console.warn(
        `Failed to collect signatures from ${errors.length} member(s):`,
        errors
      );
    }

    if (signatures.length === 0) {
      throw new Error(
        'Failed to collect any signatures from committee members'
      );
    }

    return signatures;
  }
}
