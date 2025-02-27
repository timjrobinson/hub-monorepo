import {
  bytesIncrement,
  FARCASTER_EPOCH,
  HubAsyncResult,
  HubError,
  HubEvent,
  HubResult,
  isHubError,
  isMergeMessageHubEvent,
  isMergeOnChainHubEvent,
  isMergeUsernameProofHubEvent,
  isPruneMessageHubEvent,
  isRevokeMessageHubEvent,
  MergeMessageHubEvent,
  MergeOnChainEventHubEvent,
  MergeUsernameProofHubEvent,
  PruneMessageHubEvent,
  RevokeMessageHubEvent,
  StoreType,
} from "@farcaster/hub-nodejs";
import AbstractRocksDB from "@farcaster/rocksdb";
import AsyncLock from "async-lock";
import { err, ok, ResultAsync } from "neverthrow";
import { TypedEmitter } from "tiny-typed-emitter";
import RocksDB, { Transaction } from "../db/rocksdb.js";
import { RootPrefix, UserMessagePostfix, UserPostfix } from "../db/types.js";
import { StorageCache } from "./storageCache.js";
import { makeTsHash, unpackTsHash } from "../db/message.js";
import {
  bytesCompare,
  CastAddMessage,
  CastRemoveMessage,
  getFarcasterTime,
  LinkAddMessage,
  LinkRemoveMessage,
  ReactionAddMessage,
  ReactionRemoveMessage,
  UserDataAddMessage,
  VerificationAddAddressMessage,
  VerificationRemoveMessage,
} from "@farcaster/core";
import { logger } from "../../utils/logger.js";

const PRUNE_TIME_LIMIT_DEFAULT = 60 * 60 * 24 * 3 * 1000; // 3 days in ms
const DEFAULT_LOCK_MAX_PENDING = 1_000;
const DEFAULT_LOCK_TIMEOUT = 500; // in ms

// @ts-ignore
const STORE_TO_SET: Record<StoreType, UserMessagePostfix> = {
  [StoreType.CASTS]: UserPostfix.CastMessage,
  [StoreType.LINKS]: UserPostfix.LinkMessage,
  [StoreType.REACTIONS]: UserPostfix.ReactionMessage,
  [StoreType.USER_DATA]: UserPostfix.UserDataMessage,
  [StoreType.VERIFICATIONS]: UserPostfix.VerificationMessage,
  [StoreType.USERNAME_PROOFS]: UserPostfix.UsernameProofMessage,
};

type PrunableMessage =
  | CastAddMessage
  | CastRemoveMessage
  | ReactionAddMessage
  | ReactionRemoveMessage
  | UserDataAddMessage
  | VerificationAddAddressMessage
  | VerificationRemoveMessage
  | LinkAddMessage
  | LinkRemoveMessage;

export type StoreUsage = {
  used: number;
  earliestTimestamp: number;
  earliestHash: Uint8Array;
};

export type StoreEvents = {
  /**
   * mergeMessage is emitted when a message is merged into one of the stores. If
   * messages are deleted as part of the merge transaction (i.e. due to conflicts between
   * messages), they are emitted as part of the deletedMessages argument.
   */
  mergeMessage: (event: MergeMessageHubEvent) => void;

  /**
   * pruneMessage is emitted when a message is pruned from a store due to size
   * or time-based limits.
   */
  pruneMessage: (event: PruneMessageHubEvent) => void;

  /**
   * revokeMessage is emitted when a message is deleted because its signer has been
   * removed. Signers are removed when SignerRemove messages are merged or an fid changes
   * custody address.
   */
  revokeMessage: (event: RevokeMessageHubEvent) => void;

  /**
   * mergeUsernameProofEvent is emitted when a username proof from the fname server
   * is merged into the UserDataStore.
   */
  mergeUsernameProofEvent: (event: MergeUsernameProofHubEvent) => void;

  /**
   * mergeOnChainEvent is emitted when a on chain event is merged into the
   * OnChainEventStore.
   */
  mergeOnChainEvent: (event: MergeOnChainEventHubEvent) => void;
};

export type HubEventArgs = Omit<HubEvent, "id">;

// Chosen to keep number under Number.MAX_SAFE_INTEGER
const TIMESTAMP_BITS = 41;
const SEQUENCE_BITS = 12;

const makeEventId = (timestamp: number, seq: number): number => {
  const binaryTimestamp = timestamp.toString(2);
  let binarySeq = seq.toString(2);
  if (binarySeq.length) {
    while (binarySeq.length < SEQUENCE_BITS) {
      binarySeq = `0${binarySeq}`;
    }
  }

  return parseInt(binaryTimestamp + binarySeq, 2);
};

export class HubEventIdGenerator {
  private _lastTimestamp: number; // ms since epoch
  private _lastSeq: number;
  private _epoch: number;

  constructor(options: { epoch?: number; lastTimestamp?: number; lastIndex?: number } = {}) {
    this._epoch = options.epoch ?? 0;
    this._lastTimestamp = options.lastTimestamp ?? 0;
    this._lastSeq = options.lastIndex ?? 0;
  }

  generateId(options: { currentTimestamp?: number } = {}): HubResult<number> {
    const timestamp = (options.currentTimestamp || Date.now()) - this._epoch;

    if (timestamp === this._lastTimestamp) {
      this._lastSeq = this._lastSeq + 1;
    } else {
      this._lastTimestamp = timestamp;
      this._lastSeq = 0;
    }

    if (this._lastTimestamp >= 2 ** TIMESTAMP_BITS) {
      return err(new HubError("bad_request.invalid_param", `timestamp > ${TIMESTAMP_BITS} bits`));
    }

    if (this._lastSeq >= 2 ** SEQUENCE_BITS) {
      return err(new HubError("bad_request.invalid_param", `sequence > ${SEQUENCE_BITS} bits`));
    }

    return ok(makeEventId(this._lastTimestamp, this._lastSeq));
  }
}

const makeEventKey = (id?: number): Buffer => {
  const buffer = Buffer.alloc(1 + (id ? 8 : 0));
  buffer.writeUint8(RootPrefix.HubEvents, 0);
  if (id) {
    buffer.writeBigUint64BE(BigInt(id), 1);
  }
  return buffer;
};

const putEventTransaction = (txn: Transaction, event: HubEvent): Transaction => {
  const key = makeEventKey(event.id);
  const value = Buffer.from(HubEvent.encode(event).finish());
  return txn.put(key, value);
};

export type StoreEventHandlerOptions = {
  lockMaxPending?: number | undefined;
  lockTimeout?: number | undefined;
};

class StoreEventHandler extends TypedEmitter<StoreEvents> {
  private _db: RocksDB;
  private _generator: HubEventIdGenerator;
  private _lock: AsyncLock;
  private _storageCache: StorageCache;

  constructor(db: RocksDB, options: StoreEventHandlerOptions = {}) {
    super();

    this._db = db;
    this._generator = new HubEventIdGenerator({ epoch: FARCASTER_EPOCH });
    this._lock = new AsyncLock({
      maxPending: options.lockMaxPending ?? DEFAULT_LOCK_MAX_PENDING,
      timeout: options.lockTimeout ?? DEFAULT_LOCK_TIMEOUT,
    });

    this._storageCache = new StorageCache(this._db);
  }

  async getCurrentStorageUnitsForFid(fid: number): HubAsyncResult<number> {
    const units = await this._storageCache.getCurrentStorageUnitsForFid(fid);

    if (units.isOk() && units.value === 0) {
      logger.debug({ fid }, "fid has no registered storage, would be pruned");
    }

    return units.map((u) => {
      return u;
    });
  }

  async getUsage(fid: number, store: StoreType): HubAsyncResult<StoreUsage> {
    const set = STORE_TO_SET[store];
    if (!set) {
      return err(new HubError("bad_request.invalid_param", `invalid store type ${store}`));
    }
    const messageCount = await this.getCacheMessageCount(fid, set);
    if (messageCount.isErr()) {
      return err(messageCount.error);
    }
    const earliestTsHash = await this.getEarliestTsHash(fid, set);
    if (earliestTsHash.isErr()) {
      return err(earliestTsHash.error);
    }
    let earliestTimestamp = 0;
    let earliestHash = new Uint8Array();
    if (earliestTsHash.value !== undefined) {
      const unpackResult = unpackTsHash(earliestTsHash.value);
      if (unpackResult.isOk()) {
        [earliestTimestamp, earliestHash] = unpackResult.value;
      }
    }

    return ok({
      used: messageCount.value,
      earliestTimestamp,
      earliestHash,
    });
  }

  async getCacheMessageCount(fid: number, set: UserMessagePostfix): HubAsyncResult<number> {
    return this._storageCache.getMessageCount(fid, set);
  }

  async getEarliestTsHash(fid: number, set: UserMessagePostfix): HubAsyncResult<Uint8Array | undefined> {
    return this._storageCache.getEarliestTsHash(fid, set);
  }

  async syncCache(): HubAsyncResult<void> {
    return ResultAsync.fromPromise(this._storageCache.syncFromDb(), (e) => e as HubError);
  }

  async getEvent(id: number): HubAsyncResult<HubEvent> {
    const key = makeEventKey(id);
    const result = await ResultAsync.fromPromise(this._db.get(key), (e) => e as HubError);
    return result.map((buffer) => HubEvent.decode(new Uint8Array(buffer as Buffer)));
  }

  getEventsIteratorOpts(
    options: { fromId?: number | undefined; toId?: number | undefined } = {},
  ): HubResult<AbstractRocksDB.IteratorOptions> {
    const minKey = makeEventKey(options.fromId);
    const maxKey = options.toId ? ok(makeEventKey(options.toId)) : bytesIncrement(Uint8Array.from(makeEventKey()));
    if (maxKey.isErr()) {
      return err(maxKey.error);
    }
    return ok({ gte: minKey, lt: Buffer.from(maxKey.value) });
  }

  async getEvents(fromId?: number): HubAsyncResult<HubEvent[]> {
    const events: HubEvent[] = [];
    const iteratorOpts = this.getEventsIteratorOpts({ fromId });
    if (iteratorOpts.isErr()) {
      return err(iteratorOpts.error);
    }

    await this._db.forEachIterator((_key, value) => {
      const event = HubEvent.decode(Uint8Array.from(value as Buffer));
      events.push(event);
    }, iteratorOpts.value);

    return ok(events);
  }

  async getEventsPage(
    fromId: number,
    pageSize: number,
  ): HubAsyncResult<{ events: HubEvent[]; nextPageEventId: number }> {
    const events: HubEvent[] = [];
    const iteratorOpts = this.getEventsIteratorOpts({ fromId });
    if (iteratorOpts.isErr()) {
      return err(iteratorOpts.error);
    }

    let lastEventId = fromId;
    await this._db.forEachIterator((key, value) => {
      const event = HubEvent.decode(Uint8Array.from(value as Buffer));
      events.push(event);

      if (key) {
        lastEventId = Number(key.readBigUint64BE(1));
      }

      if (events.length >= pageSize) {
        return true;
      }

      return false;
    }, iteratorOpts.value);

    return ok({ events, nextPageEventId: lastEventId + 1 });
  }

  public async isPrunable(
    message: PrunableMessage,
    set: UserMessagePostfix,
    sizeLimit: number,
    timeLimit: number | undefined = undefined,
  ): HubAsyncResult<boolean> {
    const farcasterTime = getFarcasterTime();
    if (farcasterTime.isErr()) {
      return err(farcasterTime.error);
    }

    // Calculate the timestamp cut-off to prune if set supports time based expiry
    if (timeLimit !== undefined) {
      const timestampToPrune = farcasterTime.value - timeLimit;

      if (message.data.timestamp < timestampToPrune) {
        return ok(true);
      }
    }

    const units = await this.getCurrentStorageUnitsForFid(message.data.fid);

    if (units.isErr()) {
      return err(units.error);
    }

    const messageCount = await this.getCacheMessageCount(message.data.fid, set);
    if (messageCount.isErr()) {
      return err(messageCount.error);
    }

    if (messageCount.value < sizeLimit * units.value) {
      return ok(false);
    }

    const earliestTimestamp = await this.getEarliestTsHash(message.data.fid, set);
    if (earliestTimestamp.isErr()) {
      return err(earliestTimestamp.error);
    }
    const tsHash = makeTsHash(message.data.timestamp, message.hash);
    if (tsHash.isErr()) {
      return err(tsHash.error);
    }
    if (earliestTimestamp.value === undefined) {
      return ok(false);
    }
    if (bytesCompare(tsHash.value, earliestTimestamp.value) < 0) {
      return ok(true);
    } else {
      return ok(false);
    }
  }

  async commitTransaction(txn: Transaction, eventArgs: HubEventArgs): HubAsyncResult<number> {
    return this._lock
      .acquire("commit", async () => {
        const eventId = this._generator.generateId();
        if (eventId.isErr()) {
          throw eventId.error;
        }
        const event = HubEvent.create({ ...eventArgs, id: eventId.value });
        // TODO: validate event
        // biome-ignore lint/style/noParameterAssign: legacy code, avoid using ignore for new code
        txn = putEventTransaction(txn, event);

        await this._db.commit(txn);

        void this._storageCache.processEvent(event);
        void this.broadcastEvent(event);

        return ok(event.id);
      })
      .catch((e: Error) => {
        return err(isHubError(e) ? e : new HubError("unavailable.storage_failure", e.message));
      });
  }

  async pruneEvents(timeLimit?: number): HubAsyncResult<void> {
    const toId = makeEventId(Date.now() - FARCASTER_EPOCH - (timeLimit ?? PRUNE_TIME_LIMIT_DEFAULT), 0);

    const iteratorOpts = this.getEventsIteratorOpts({ toId });

    if (iteratorOpts.isErr()) {
      return err(iteratorOpts.error);
    }

    const result = await this._db.forEachIterator(
      async (key, _value) => {
        const result = await ResultAsync.fromPromise(this._db.del(key as Buffer), (e) => e as HubError);
        if (result.isErr()) {
          return err(result.error);
        }
        return false;
      },
      iteratorOpts.value,
      10 * 60 * 1000, // 10 minutes
    );

    if (result) {
      return err(result.error);
    } else {
      return ok(undefined);
    }
  }

  private broadcastEvent(event: HubEvent): HubResult<void> {
    if (isMergeMessageHubEvent(event)) {
      this.emit("mergeMessage", event);
    } else if (isPruneMessageHubEvent(event)) {
      this.emit("pruneMessage", event);
    } else if (isRevokeMessageHubEvent(event)) {
      this.emit("revokeMessage", event);
    } else if (isMergeUsernameProofHubEvent(event)) {
      this.emit("mergeUsernameProofEvent", event);
    } else if (isMergeOnChainHubEvent(event)) {
      this.emit("mergeOnChainEvent", event);
    } else {
      return err(new HubError("bad_request.invalid_param", "invalid event type"));
    }

    return ok(undefined);
  }
}

export default StoreEventHandler;
