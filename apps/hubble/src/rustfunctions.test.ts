import { blake3 } from "@noble/hashes/blake3";
import { createEd25519PeerId } from "@libp2p/peer-id-factory";
import { unmarshalPrivateKey } from "@libp2p/crypto/keys";
import { nativeBlake3Hash20, nativeEd25519SignMessageHash, nativeEd25519Verify } from "./rustfunctions.js";
import { Factories, ed25519 } from "@farcaster/hub-nodejs";
import bs58 from "bs58";
import nacl from "tweetnacl";

describe("blake3 tests", () => {
  test("hashes match rust", () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

    const rusthash = nativeBlake3Hash20(data);
    const hash = blake3.create({ dkLen: 20 }).update(data).digest();

    expect(rusthash).toEqual(hash);
  });

  test("hashes match rust for empty data", () => {
    const data = new Uint8Array([]);

    const rusthash = nativeBlake3Hash20(data);
    const hash = blake3(data, { dkLen: 20 });

    expect(rusthash).toEqual(hash);
  });
});

describe("ed25519 tests", () => {
  test("native signing with peer key and verification", async () => {
    const peerId = await createEd25519PeerId();
    const hash = Factories.Bytes.build({}, { transient: { length: 32 } });
    const privateKey = peerId.privateKey;
    if (!privateKey) {
      fail("peerid does not contain private key");
    }

    const rawPrivKey = await unmarshalPrivateKey(privateKey);
    const nativeSignature = await nativeEd25519SignMessageHash(hash, rawPrivKey.marshal());

    expect(
      (await ed25519.verifyMessageHashSignature(nativeSignature, hash, rawPrivKey.public.marshal()))._unsafeUnwrap(),
    ).toBeTruthy();
    expect(await nativeEd25519Verify(nativeSignature, hash, rawPrivKey.public.marshal())).toBeTruthy();
  });

  test("create and verify signature", async () => {
    const signer = Factories.Ed25519Signer.build();
    const signerKey = (await signer.getSignerKey())._unsafeUnwrap();
    const hash = Factories.Bytes.build({}, { transient: { length: 32 } });
    const signature = (await signer.signMessageHash(hash))._unsafeUnwrap();

    expect((await ed25519.verifyMessageHashSignature(signature, hash, signerKey))._unsafeUnwrap()).toBeTruthy();
    expect(await nativeEd25519Verify(signature, hash, signerKey)).toBeTruthy();
  });

  test("bad signature fails", async () => {
    const signer = Factories.Ed25519Signer.build();
    const signerKey = (await signer.getSignerKey())._unsafeUnwrap();
    const hash = Factories.Bytes.build({}, { transient: { length: 32 } });
    const signature = (await signer.signMessageHash(hash))._unsafeUnwrap();

    const badHash = Factories.Bytes.build({}, { transient: { length: 32 } });

    expect((await ed25519.verifyMessageHashSignature(signature, badHash, signerKey))._unsafeUnwrap()).toBeFalsy();
    expect(await nativeEd25519Verify(signature, badHash, signerKey)).toBeFalsy();
  });

  test("solana phantom wallet", async () => {
    const signatureBytes =
      "162,101,41,6,5,104,193,229,245,145,242,172,232,158,221,238,199,77,66,219,149,106,195,197,174,96,147,167,234,176,159,206,197,86,30,143,108,138,212,159,18,152,169,157,115,10,253,42,97,93,8,131,85,220,69,10,180,42,151,187,1,169,112,1";
    const signature = Uint8Array.from(signatureBytes.split(",").map(Number));
    const inputSignerKey = "BRrCfKnCBcrB8twtXH6yVjd82yQ6eeAnAQr5KxedJ3ac";
    const signerKey = bs58.decode(inputSignerKey);
    const message =
      '�solana offchain �ʕ<�~tXv��5�W�u<퉍�4OOkB� ��p�⏀�R�8ㅁ����������n�M;�` {"fid":"8379","address":"BRrCfKnCBcrB8twtXH6yVjd82yQ6eeAnAQr5KxedJ3ac","network":"mainnet-beta"}';
    const encodedMessage = new TextEncoder().encode(message);
    const isVerified = nacl.sign.detached.verify(encodedMessage, signature, signerKey);
    expect(isVerified).toBeTruthy();
  });

  test("bad signer fails", async () => {
    const signer = Factories.Ed25519Signer.build();
    const hash = Factories.Bytes.build({}, { transient: { length: 32 } });
    const signature = (await signer.signMessageHash(hash))._unsafeUnwrap();

    const badSigner = Factories.Bytes.build({}, { transient: { length: 32 } });

    expect((await ed25519.verifyMessageHashSignature(signature, hash, badSigner))._unsafeUnwrap()).toBeFalsy();
    expect(await nativeEd25519Verify(signature, hash, badSigner)).toBeFalsy();
  });

  test("bad signature fails", async () => {
    const signer = Factories.Ed25519Signer.build();
    const signerKey = (await signer.getSignerKey())._unsafeUnwrap();
    const hash = Factories.Bytes.build({}, { transient: { length: 32 } });

    const badSignature = Factories.Bytes.build({}, { transient: { length: 64 } });

    expect((await ed25519.verifyMessageHashSignature(badSignature, hash, signerKey))._unsafeUnwrap()).toBeFalsy();
    expect(await nativeEd25519Verify(badSignature, hash, signerKey)).toBeFalsy();
  });

  test("0 length data fails", async () => {
    const signer = Factories.Ed25519Signer.build();
    const signerKey = (await signer.getSignerKey())._unsafeUnwrap();
    const hash = Factories.Bytes.build({}, { transient: { length: 32 } });
    const signature = (await signer.signMessageHash(hash))._unsafeUnwrap();

    const empty = new Uint8Array([]);

    expect(await nativeEd25519Verify(empty, hash, signerKey)).toBeFalsy();
    expect(await nativeEd25519Verify(signature, empty, signerKey)).toBeFalsy();
    expect(await nativeEd25519Verify(signature, hash, empty)).toBeFalsy();
  });
});
