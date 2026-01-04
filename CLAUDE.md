# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Baileys is a TypeScript/JavaScript library for interacting with WhatsApp Web using WebSockets. This fork (@iamrony777/baileys) adds custom stores for MongoDB and Redis authentication and message storage.

**Key differences from original:** Custom authentication and storage implementations (MongoDB/Redis) for auth state, messages, and chats.

## Development Commands

### Build
```bash
yarn build              # Build TypeScript to lib/ directory
yarn build:all          # Build + generate docs
yarn build:docs         # Generate TypeDocs documentation
```

### Testing
```bash
yarn test               # Run unit tests (*.test.ts files)
yarn test:e2e           # Run end-to-end tests (*.test-e2e.ts)
```

### Linting & Formatting
```bash
yarn lint               # Type-check and lint
yarn lint:fix           # Auto-fix linting issues + format
yarn format             # Format code with Prettier
```

### Running Examples
```bash
yarn example            # Run Example/example.ts with tsx
yarn example:node       # Run with ts-node
yarn example:mobile     # Run with mobile config
```

### Protocol Buffers
```bash
yarn gen:protobuf       # Regenerate WAProto statics from .proto files
```

## Architecture Overview

### Core Layer Structure (Bottom to Top)

1. **WAProto/** - WhatsApp Protocol Buffers definitions
   - Auto-generated from WAProto.proto
   - Contains all message type definitions

2. **src/Signal/** - Libsignal protocol implementation
   - Group encryption/decryption
   - Signal session management
   - Uses `libsignal` native bindings

3. **src/WABinary/** - Binary protocol encoding/decoding
   - WhatsApp's custom binary format
   - JID utilities (handling WhatsApp IDs)
   - Constants for protocol tags

4. **src/Socket/** - Socket connection layers (Layered architecture)
   - `Client/websocket.ts` - Base WebSocket connection
   - `socket.ts` - Core socket with auth and connection handling
   - `messages-send.ts` - Message sending logic
   - `messages-recv.ts` - Message receiving and decryption
   - `groups.ts` - Group management
   - `chats.ts` - Chat management
   - `business.ts` - Business account features
   - `newsletter.ts` - Newsletter/Channel features
   - `communities.ts` - Top-level socket (exports final makeWASocket)

5. **src/Store/** - Data persistence implementations
   - `make-in-memory-store.ts` - Default in-memory store
   - `make-mongo-store.ts` - MongoDB storage (custom addition)
   - `make-redis-store.ts` - Redis storage (custom addition)

6. **src/Utils/** - Helper utilities
   - `use-multi-file-auth-state.ts` - File-based auth
   - `use-mongodb-auth.ts` - MongoDB auth state (custom)
   - `use-redis-auth.ts` - Redis auth state (custom)
   - `messages.ts`, `messages-media.ts` - Message utilities
   - `signal.ts` - Signal protocol helpers

7. **src/Types/** - TypeScript type definitions
   - All interfaces and types for the library

### Socket Layer Composition

Socket is built using composition pattern - each layer adds functionality:
- Base WebSocket → Auth/Connection → Messages → Groups → Chats → Business → Newsletter → Communities

The `makeWASocket()` function in `src/Socket/index.ts` creates the final composed socket.

### Authentication Flow

1. Create auth state handler (file/MongoDB/Redis)
2. Initialize socket with auth state
3. Listen to `creds.update` event
4. Save credentials when updated (critical for message delivery)

**Important:** Always save auth keys when `authState.keys.set()` is called. Failing to do so breaks message encryption.

### Store Architecture

Stores listen to socket events and maintain:
- Contacts
- Chats
- Messages
- Groups metadata

Custom stores (MongoDB/Redis) persist this data to databases instead of memory.

## Authentication State Implementations

### Production-Ready Auth States

Both MongoDB and Redis auth state implementations include enterprise-grade features:

**MongoDB Auth** (`src/Utils/use-mongodb-auth.ts`):
- **Mutex-based concurrency control:** Per-key locks prevent race conditions during concurrent operations
- **Connection health checks:** Validates MongoDB connection before each operation using `ping` command
- **Comprehensive error handling:** Catches `MongoNetworkError`, `MongoNetworkTimeoutError`, `MongoServerError`, `MongoNotConnectedError`, and `MongoOperationTimeoutError`
- **Enhanced logging:** Trace/debug/info/warn/error levels for detailed operation tracking
- **Full session deletion:** `removeCreds()` deletes ALL documents in collection, not just credentials

**Redis Auth** (`src/Utils/use-redis-auth.ts`):
- **Mutex-based concurrency control:** Same per-key locking pattern as MongoDB
- **Connection health checks:** Uses `isReady` property and `ping` command
- **Comprehensive error handling:** Detects READONLY, LOADING, timeout, closed, and ECONNREFUSED errors
- **Enhanced logging:** Same detailed logging as MongoDB implementation
- **Full session deletion:** `removeCreds()` deletes entire authKey hash

### Key Features

1. **Graceful Degradation:** Read operations return `null` on errors instead of crashing
2. **Fail-Fast Writes:** Write operations throw descriptive errors for debugging
3. **Silent Removals:** Remove operations ignore errors (expected behavior)
4. **Connection Verification:** Both fail-fast on initialization if database is not connected
5. **Lock Discipline:** All mutex locks released in `finally` blocks to prevent deadlocks

### Usage Example

```typescript
// MongoDB
import { MongoClient } from 'mongodb'
import { useMongoDBAuthState } from '@iamrony777/baileys'

const mongoClient = new MongoClient(process.env.MONGODB_URL)
await mongoClient.connect()
const collection = mongoClient.db('whatsapp').collection('auth')
const { state, saveCreds, removeCreds } = await useMongoDBAuthState(collection, logger)

// Redis
import { createClient } from 'redis'
import { useRedisAuthState } from '@iamrony777/baileys'

const redisClient = createClient({ url: process.env.REDIS_URL })
await redisClient.connect()
const { state, saveCreds, removeCreds } = await useRedisAuthState(redisClient, 'auth', logger)
```

### Important Considerations

- **Logger parameter is optional** but highly recommended for production debugging
- **removeCreds() behavior:** Now performs complete session cleanup (deletes all auth data)
- **Performance:** Mutex overhead is minimal (~0.1-1ms per operation)
- **Concurrency:** Per-key locking minimizes contention, operations on different keys run in parallel
- **Network failures:** Connection health checks prevent operations on disconnected clients

## Code Patterns

### Working with Messages

All messages use `proto.WebMessageInfo` type from WAProto. Key utilities:
- `getContentType(msg)` - Get message type
- `downloadMediaMessage(msg)` - Download media
- `generateWAMessageFromContent()` - Create messages

### JID (WhatsApp ID) Format

- Individual: `[country][number]@s.whatsapp.net`
- Group: `[id]@g.us`
- Broadcast: `[timestamp]@broadcast`
- Status: `status@broadcast`
- Newsletter: `[id]@newsletter`

Use helpers from `src/WABinary/jid-utils.ts`

### Event Handling

Socket uses EventEmitter. Key events:
- `connection.update` - Connection state changes
- `creds.update` - Credentials updated (MUST save)
- `messages.upsert` - New messages
- `messages.update` - Message updates (edits, reactions, polls)
- `chats.update` - Chat metadata changes
- `groups.update` - Group metadata changes

See `src/Types/Events.ts` for complete event types.

## Database Setup

Create `.env` file (see `.env.example`):
```bash
REDIS_URL=redis://localhost:6379
MONGODB_URL=mongodb://localhost:27017
```

**Recommendation:** Use Redis for auth (fastest), MongoDB for messages/chats.

## Testing Patterns

- Unit tests in `src/__tests__/` mirror source structure
- Use `src/__tests__/TestUtils/session.ts` for test session helpers
- E2E tests require actual WhatsApp connection

## TypeScript Configuration

- `tsconfig.json` - Development config (noEmit: true)
- `tsconfig.build.json` - Production build config
- Strict mode enabled
- ESM modules with `verbatimModuleSyntax`
- Build output: `lib/` directory

## Important Notes

- **Breaking changes:** This fork is unstable and may have bugs
- **Multi-device only:** Legacy WhatsApp Web support removed in v5
- **Node.js requirement:** >=20.0.0
- **ESM package:** Uses ES modules, not CommonJS
- **Auth state is critical:** Improper key management causes message delivery failures
- **Poll decryption:** Requires implementing `getMessage` in store
- **Message retry:** Use `msgRetryCounterCache` external to socket to prevent loops

## Signal Protocol Notes

Uses libsignal for end-to-end encryption:
- Session establishment via X3DH
- Double Ratchet for message encryption
- Sender keys for group messages
- Pre-key bundles managed in `src/Utils/pre-key-manager.ts`

## Contributing

- Follow existing code patterns in each Socket layer
- Update types in `src/Types/` when adding features
- Add tests for new utilities in `src/__tests__/`
- Run `yarn lint:fix` before committing
- Protocol changes require updating WAProto.proto + regenerating statics
