import { Client } from '@orbs-network/orbs-client';
import { SignatureData } from './types';

export class SignatureCollector {
  private client: Client;

  constructor(seedIP: string) {
    this.client = new Client(seedIP);
  }

  async init(): Promise<void> {
    await this.client.init();
    if (!this.client.initialized()) {
      throw new Error('Failed to initialize ORBS client');
    }
  }

  async collectSignatures(): Promise<SignatureData[]> {
    // Get all committee nodes
    const nodes = await this.client.getNodes({ committeeOnly: true });

    if (nodes.size() === 0) {
      throw new Error('No committee nodes found');
    }

    const signatures: SignatureData[] = [];
    const errors: Array<{ node: string; error: string }> = [];

    // Collect signatures in parallel
    const promises: Promise<void>[] = [];
    let node = nodes.next();

    while (node !== null) {
      const currentNode = node;
      const nodeAddress = currentNode.guardianAddress || currentNode.nodeAddress || currentNode.name;

      promises.push(
        (async () => {
          try {
            // Call the lambda endpoint to get signed committee
            const response = await currentNode.get('vm-lambda/cmt-sync/getSignedCommittee');

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data: any = await response.json();

            // Parse the signature from the response
            // Adjust based on actual API response format
            const signature = data.signature || data.sig || data;

            if (!signature || typeof signature !== 'string') {
              throw new Error('Invalid signature format in response');
            }

            signatures.push({
              signature: signature.startsWith('0x') ? signature : `0x${signature}`,
              nodeAddress,
            });
          } catch (error) {
            errors.push({
              node: nodeAddress,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })()
      );

      node = nodes.next();
    }

    // Wait for all requests to complete
    await Promise.all(promises);

    // Log errors but continue if we have at least some signatures
    if (errors.length > 0) {
      console.warn(`Failed to collect signatures from ${errors.length} nodes:`, errors);
    }

    if (signatures.length === 0) {
      throw new Error('Failed to collect any signatures from committee nodes');
    }

    return signatures;
  }
}

