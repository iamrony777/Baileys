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
```

### Testing
```bash
yarn test               # Run unit tests (*.test.ts files)
yarn test:e2e           # Run end-to-end tests (*.test-e2e.ts)
```

Tests use Jest with `ts-jest/presets/default-esm` and require `--experimental-vm-modules`. The test scripts in package.json handle this automatically.

### Linting & Formatting
```bash
yarn lint               # Type-check and lint
yarn lint:fix           # Auto-fix linting issues + format
yarn format             # Format code with Prettier
```

### Running Examples
```bash
yarn example            # Run Example/example.ts with tsx
```

### Protocol Buffers
```bash
yarn gen:protobuf       # Regenerate WAProto statics from .proto files
```

## Architecture Overview

### Core Layer Structure

1. **WAProto/** - Auto-generated Protocol Buffer definitions for all WhatsApp message types
2. **src/Signal/** - Libsignal protocol implementation (E2E encryption, group sender keys, X3DH, Double Ratchet)
3. **src/WABinary/** - WhatsApp's custom binary protocol encoding/decoding, JID utilities, protocol constants
4. **src/Socket/** - Socket connection layers (see composition below)
5. **src/Store/** - Data persistence (in-memory, MongoDB, Redis, cache-manager)
6. **src/Utils/** - Auth state handlers, message utilities, crypto, media handling
7. **src/Types/** - TypeScript type definitions and interfaces

### Socket Layer Composition

Socket is built using a composition pattern where each layer wraps the previous one. The **actual composition order** (bottom to top) is:

```
Client/websocket.ts → socket.ts → chats.ts → groups.ts → newsletter.ts →
messages-send.ts → messages-recv.ts → business.ts → communities.ts → index.ts
```

Each layer calls the layer below it (e.g., `makeGroupsSocket` calls `makeChatsSocket`). The final `makeWASocket()` in `src/Socket/index.ts` creates the fully composed socket.

Additional socket utilities: `mex.ts` provides GraphQL query helpers (`executeWMexQuery`).

### Authentication Flow

1. Create auth state handler (file/MongoDB/Redis)
2. Initialize socket with auth state
3. Listen to `creds.update` event and save credentials (critical for message delivery)

**Important:** Always save auth keys when `authState.keys.set()` is called. Failing to do so breaks message encryption.

### Auth State Implementations

- **File-based:** `src/Utils/use-multi-file-auth-state.ts`
- **MongoDB:** `src/Utils/use-mongodb-auth.ts` — mutex-based concurrency, connection health checks
- **Redis:** `src/Utils/use-redis-auth.ts` — same concurrency/health patterns as MongoDB

Both MongoDB and Redis implementations use per-key mutex locks, connection health verification before operations, and graceful degradation (reads return `null` on error, writes throw).

### Store Implementations

Stores listen to socket events and maintain contacts, chats, messages, and group metadata:
- `make-in-memory-store.ts` — default in-memory store
- `make-mongo-store.ts` — MongoDB persistence
- `make-redis-store.ts` — Redis persistence
- `make-cache-manager-store.ts` — cache-manager based store

## Code Patterns

### JID (WhatsApp ID) Format

- Individual: `[country][number]@s.whatsapp.net`
- Group: `[id]@g.us`
- Broadcast: `[timestamp]@broadcast`
- Newsletter: `[id]@newsletter`

Use helpers from `src/WABinary/jid-utils.ts`.

### Key Events

- `connection.update` — connection state changes
- `creds.update` — credentials updated (MUST save)
- `messages.upsert` — new messages
- `messages.update` — message updates (edits, reactions, polls)

Full event types in `src/Types/Events.ts`.

### Message Types

All messages use `proto.WebMessageInfo` from WAProto. Key utilities:
- `getContentType(msg)` — get message type
- `downloadMediaMessage(msg)` — download media
- `generateWAMessageFromContent()` — create messages

### Interactive Messages (Buttons, Lists, Carousels, Albums)

Sending interactive messages uses the `nativeButtons`, `nativeList`, `nativeCarousel`, and `album` content types in `AnyMessageContent`. The send path in `messages-send.ts` automatically injects the required `biz` binary node for WhatsApp protocol compliance, gated behind `enableInteractiveMessages` config (default: true).

**Key functions** in `src/Utils/messages.ts`:
- `generateButtonMessage()` — CTA buttons (url, copy, call) with viewOnceMessage wrapper
- `generateCarouselMessage()` — Multi-card carousel with media (direct interactiveMessage)
- `generateListMessage()` — List with sections (viewOnceMessage wrapper)
- `generateListMessageLegacy()` — Legacy listMessage format (used internally to avoid error 479)
- `generateProductListMessage()` — Multi-product from WhatsApp Business catalog
- `generateProductCarouselMessage()` — Product carousel from catalog
- `formatNativeFlowButton()` — Converts user-friendly button types to WhatsApp native flow format

**Album messages** use `sendAlbumMessage()` (NOT `sendMessage()`):
- Sends album root with `expectedImageCount`/`expectedVideoCount`
- Then sends individual media items with `messageAssociation(MEDIA_ALBUM)` linking to the root
- Supports adaptive delay, retry logic, and per-item result tracking

**Biz node injection** (`messages-send.ts`):
- `getButtonType()` detects interactive message type (checks viewOnceMessage wrappers)
- `isCarouselMessage()`, `isCatalogMessage()`, `isListNativeFlow()` — helper classifiers
- nativeFlowMessage(single_select) is auto-converted to legacy listMessage to avoid error 479
- Bot node skipped for native_flow, carousels, and catalog messages

## Important Notes

- **ESM package** with `verbatimModuleSyntax` — use `import type` for type-only imports
- **Node.js >=20.0.0** required
- **Multi-device only** — legacy WhatsApp Web support removed in v5
- **Poll decryption** requires implementing `getMessage` in store
- **Message retry** — use `msgRetryCounterCache` external to socket to prevent loops
- **Package manager:** yarn 4.x (Berry)

## Database Setup

Create `.env` file (see `.env.example`):
```bash
REDIS_URL=redis://localhost:6379
MONGODB_URL=mongodb://localhost:27017
```
