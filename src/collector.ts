import { CommitteeData, CommitteeMember, SignatureData } from './types';

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

    const addr =
      member.orbsAddress.startsWith('0x') ? member.orbsAddress : `0x${member.orbsAddress}`;
    return {
      signature: signature.startsWith('0x') ? signature : `0x${signature}`,
      orbsAddress: addr,
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
