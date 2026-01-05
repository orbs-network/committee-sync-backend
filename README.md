# Committee Sync Backend

A Node.js TypeScript service that periodically synchronizes the ORBS L3 network committee to multiple EVM chains by collecting signatures from committee nodes and submitting them via smart contract transactions.

## Overview

This service monitors the ORBS L3 network committee and automatically syncs committee changes to configured EVM chains. When a committee change is detected, it:

1. Fetches the current committee from ORBS L3 network using `@orbs-network/orbs-client` via the `/service/vm-lambda/cmt-sync/getCurrentCommittee` endpoint
2. Collects signatures from all committee nodes via the `/service/vm-lambda/cmt-sync/getSignedCommittee` endpoint
3. Submits the committee data and signatures to the `vote` function on committee-sync contracts across all configured EVM chains

## Architecture

```
┌─────────────────┐
│  ORBS L3 Network│
│  (orbs-client)  │
└────────┬────────┘
         │
         │ Fetch committee
         │
┌────────▼─────────────────────────────┐
│   Committee Sync Backend Service     │
│                                       │
│  ┌──────────────────────────────┐   │
│  │  Periodic Check Loop          │   │
│  │  (CHECK_INTERVAL seconds)     │   │
│  └──────────┬───────────────────┘   │
│             │                        │
│  ┌──────────▼───────────────────┐   │
│  │  Committee Change Detection   │   │
│  └──────────┬───────────────────┘   │
│             │                        │
│  ┌──────────▼───────────────────┐   │
│  │  Collect Signatures           │   │
│  │  (from all committee nodes)   │   │
│  └──────────┬───────────────────┘   │
│             │                        │
│  ┌──────────▼───────────────────┐   │
│  │  Submit to EVM Chains         │   │
│  │  (vote() function per chain)  │   │
│  └───────────────────────────────┘   │
└────────┬─────────────────────────────┘
         │
         ├──────────────┬──────────────┐
         │              │              │
    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
    │ Chain 1 │   │ Chain 2 │   │ Chain N │
    │ (EVM)   │   │ (EVM)   │   │ (EVM)   │
    └─────────┘   └─────────┘   └─────────┘
```

## Features

- **Periodic Monitoring**: Configurable interval for checking committee changes
- **Multi-Chain Support**: Syncs committee to multiple EVM chains simultaneously
- **Signature Collection**: Aggregates signatures from all committee nodes
- **Dynamic Configuration**: Reloads `chain.json` on each iteration
- **Status API**: Express server providing real-time status and activity logs
- **Error Tracking**: Comprehensive error logging and reporting

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```bash
# ORBS Network Configuration
SEED_IP=13.112.58.64                    # ORBS L3 seed node IP address

# Sync Configuration
CHECK_INTERVAL=300                      # Interval in seconds between committee checks

# EVM Chain Configuration
PRIVATE_KEY=0x...                       # Private key for signing transactions (without 0x prefix is also accepted)

# Express Server Configuration
PORT=3000                               # Port for status API server (default: 3000)
```

### Chain Configuration File

Create a `chain.json` file in the project root with the following format:

```json
[
  ["https://mainnet.infura.io/v3/YOUR_PROJECT_ID", "0x1234567890123456789012345678901234567890"],
  ["https://polygon-rpc.com", "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]
]
```

Each entry is an array `[rpcUrl, contractAddress]` where:
- First element: RPC URL string for the EVM chain
- Second element: Contract address string for the committee-sync contract

**Note**: The `chain.json` file is reloaded on every iteration, allowing dynamic chain configuration updates without restarting the service.

### Contract ABI

The contract ABI for the `vote` function will be provided separately. The expected function signature is:

```solidity
function vote(address[] memory committee, bytes[] memory signatures) external
```

Where:
- `committee`: Array of committee member addresses
- `signatures`: Array of hex-encoded signatures corresponding to each committee member

## Installation

**Prerequisites:** This project requires the `orbs-client` package to be available as a sibling directory at `../git/orbs-network/orbs-client`. The package is not yet published to npm.

```bash
# Ensure orbs-client is available as a sibling directory
# Expected structure:
# ../git/orbs-network/
#   ├── orbs-client/
#   └── committee-sync-backend/

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run the service
npm start
```

**Note:** The `orbs-client` package is imported as a local dependency from the sibling folder. Make sure both projects are cloned in the same parent directory.

## Usage

### Development

```bash
# Run with TypeScript compiler in watch mode
npm run dev

# Run tests
npm test
```

### Production

```bash
# Build the project
npm run build

# Start the service
npm start
```

## API Endpoints

### GET /status

Returns the current status of the service including activity history, sync statistics, and errors.

**Response Format:**

```json
{
  "status": "running",
  "startTime": "2024-01-01T00:00:00.000Z",
  "uptime": 3600,
  "currentCommittee": {
    "members": ["0x...", "0x..."],
    "lastUpdated": "2024-01-01T00:05:00.000Z"
  },
  "syncStats": [
    {
      "rpcUrl": "https://mainnet.infura.io/v3/YOUR_PROJECT_ID",
      "contractAddress": "0x1234567890123456789012345678901234567890",
      "totalSyncs": 5,
      "lastSync": "2024-01-01T00:05:00.000Z",
      "lastSyncStatus": "success"
    },
    {
      "rpcUrl": "https://polygon-rpc.com",
      "contractAddress": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "totalSyncs": 3,
      "lastSync": "2024-01-01T00:04:30.000Z",
      "lastSyncStatus": "success"
    }
  ],
  "activity": [
    {
      "timestamp": "2024-01-01T00:05:00.000Z",
      "type": "committee_sync",
      "rpcUrl": "https://mainnet.infura.io/v3/YOUR_PROJECT_ID",
      "contractAddress": "0x1234567890123456789012345678901234567890",
      "status": "success",
      "details": "Committee synced successfully"
    }
  ],
  "errors": [
    {
      "timestamp": "2024-01-01T00:03:00.000Z",
      "type": "signature_collection",
      "message": "Failed to collect signature from node 0x...",
      "node": "0x..."
    }
  ]
}
```

**Response Fields:**

- `status`: Current service status (`"running"` | `"error"`)
- `startTime`: ISO timestamp when the service started
- `uptime`: Service uptime in seconds
- `currentCommittee`: Current committee information
  - `members`: Array of committee member addresses
  - `lastUpdated`: ISO timestamp of last committee update
- `syncStats`: Array of per-chain synchronization statistics
  - `rpcUrl`: RPC URL for the chain
  - `contractAddress`: Contract address for the committee-sync contract
  - `totalSyncs`: Total number of successful syncs to this chain
  - `lastSync`: ISO timestamp of the last sync attempt
  - `lastSyncStatus`: Status of the last sync (`"success"` | `"error"`)
- `activity`: Array of recent activities (last N entries)
  - `timestamp`: ISO timestamp of the activity
  - `type`: Activity type (`"committee_sync"`, `"signature_collection"`, `"error"`, etc.)
  - `rpcUrl`: RPC URL for the chain (if applicable)
  - `contractAddress`: Contract address for the chain (if applicable)
  - `status`: Activity status (`"success"` | `"error"`)
  - `details`: Human-readable description
- `errors`: Array of recent errors (last N entries)
  - `timestamp`: ISO timestamp of the error
  - `type`: Error type (`"signature_collection"`, `"transaction"`, `"committee_fetch"`, etc.)
  - `message`: Error message
  - `node`: Optional node identifier if error is node-specific

## Workflow

### Committee Check Cycle

1. **Load Configuration**: Reload `chain.json` file
2. **Fetch Committee**: Use `@orbs-network/orbs-client` to get current committee from ORBS L3 network:
   - Get committee nodes using `client.getNodes({ committeeOnly: true })`
   - Call `/service/vm-lambda/cmt-sync/getCurrentCommittee` endpoint on a committee node using `node.get('vm-lambda/cmt-sync/getCurrentCommittee')`
   - Parse the response to extract the current committee data
3. **Compare**: Check if committee has changed since last check
4. **Collect Signatures**: If changed, request signatures from all committee nodes:
   - Endpoint: `/service/vm-lambda/cmt-sync/getSignedCommittee`
   - Method: GET
   - Use `node.get('vm-lambda/cmt-sync/getSignedCommittee')` for each committee node
   - Collect signatures in parallel for efficiency
5. **Submit Transactions**: For each `[rpcUrl, contractAddress]` entry in `chain.json`:
   - Connect to chain via RPC URL
   - Call `vote(committee, signatures)` function on contract at the specified address
   - Track transaction status per chain
6. **Update Status**: Record activity and update status endpoint data
7. **Wait**: Sleep for `CHECK_INTERVAL` seconds before next iteration

### Error Handling

- **Committee Fetch Errors**: Logged and reported in status endpoint, service continues
- **Signature Collection Errors**: Individual node failures are logged, service attempts to collect from remaining nodes
- **Transaction Errors**: Per-chain errors are logged separately, other chains continue processing
- **Configuration Errors**: Invalid `chain.json` format causes error log, service continues with previous configuration

## Dependencies

- `@orbs-network/orbs-client`: ORBS network client for committee data (imported from sibling folder `../git/orbs-network/orbs-client`)
- `ethers`: Ethereum library for EVM chain interactions
- `express`: Web server for status API
- `dotenv`: Environment variable management
- `typescript`: TypeScript compiler

**Local Dependency Setup:**

The `orbs-client` package must be available as a sibling directory. In `package.json`, it should be configured as:

```json
{
  "dependencies": {
    "@orbs-network/orbs-client": "file:../orbs-client"
  }
}
```

## Development

### Project Structure

```
orbs-network/
├── orbs-client/              # Sibling dependency (required)
│   └── ...
└── committee-sync-backend/
    ├── src/
    │   ├── index.ts              # Main entry point
    │   ├── config/
    │   │   └── config.ts         # Configuration loading
    │   ├── orbs/
    │   │   └── committee.ts      # ORBS committee fetching logic
    │   ├── signatures/
    │   │   └── collector.ts     # Signature collection logic
    │   ├── evm/
    │   │   └── sync.ts          # EVM chain sync logic
    │   ├── server/
    │   │   └── status.ts        # Express status server
    │   └── types/
    │       └── index.ts         # TypeScript type definitions
    ├── chain.json                # Chain configuration (user-provided)
    ├── abi.json                  # Contract ABI (user-provided)
    ├── .env                      # Environment variables (user-provided)
    ├── package.json
    ├── tsconfig.json
    └── README.md
```

**Important:** The `orbs-client` package must be available as a sibling directory. Both projects should be cloned in the same parent directory (`../git/orbs-network/`).

### TypeScript Configuration

The project uses TypeScript with strict type checking. See `tsconfig.json` for configuration details.

## Security Considerations

- **Private Key Management**: Never commit `.env` file or private keys to version control
- **RPC Endpoints**: Use secure RPC endpoints (HTTPS) in production
- **Contract Verification**: Verify contract addresses before deployment
- **Error Logging**: Avoid logging sensitive information (private keys, full transaction data)

## Troubleshooting

### Service Not Starting

- Check that all required environment variables are set
- Verify `chain.json` file exists and is valid JSON
- Ensure `SEED_IP` is reachable

### No Committee Updates

- Verify ORBS network connectivity
- Check `SEED_IP` is correct and accessible
- Review error logs in status endpoint

### Transaction Failures

- Verify `PRIVATE_KEY` has sufficient balance for gas fees
- Check RPC endpoints are accessible
- Verify contract addresses are correct
- Review transaction errors in status endpoint

## License

MIT

## References

- [ORBS Client Library](https://github.com/orbs-network/orbs-client)
- [Ethers.js Documentation](https://docs.ethers.io/)

