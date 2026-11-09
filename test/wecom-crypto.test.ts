import { describe, expect, it } from "vitest";
import { decrypt, encrypt, packReply, signatureOf, verifySignature, WeComCryptoError } from "../src/wecom/crypto.ts";

// 43 字符 EncodingAESKey（测试专用随机生成语义合法值）
const AES_KEY = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"; // 43 chars
const TOKEN = "test-token";
const CORP_ID = "ww1234567890";

describe("企微加解密（SPEC §3）", () => {
	it("encrypt → decrypt 往返一致", () => {
		const message = "<xml><ToUserName><![CDATA[ww123]]></ToUserName><Content>你好，世界 hello</Content></xml>";
		const cipher = encrypt(AES_KEY, message, CORP_ID);
		const plain = decrypt(AES_KEY, cipher);
		expect(plain.message).toBe(message);
		expect(plain.receiveId).toBe(CORP_ID);
	});

	it("密文长度非法时报错", () => {
		expect(() => decrypt(AES_KEY, "not-base64!!")).toThrow(WeComCryptoError);
	});

	it("AES key 长度非法时报错", () => {
		expect(() => encrypt("short", "x", CORP_ID)).toThrow(WeComCryptoError);
	});

	it("签名 = sha1(lexsort(token,timestamp,nonce,encrypt))", () => {
		const encryptB64 = encrypt(AES_KEY, "hello", CORP_ID);
		const sig = signatureOf(TOKEN, "1700000000", "nonce1", encryptB64);
		expect(sig).toMatch(/^[0-9a-f]{40}$/);
		expect(verifySignature(TOKEN, "1700000000", "nonce1", encryptB64, sig)).toBe(true);
		expect(verifySignature(TOKEN, "1700000000", "nonce1", encryptB64, "deadbeef".repeat(5))).toBe(false);
	});

	it("packReply 输出可被解密还原", () => {
		const xml = packReply(TOKEN, AES_KEY, CORP_ID, "ok", "1700000000", "n1");
		expect(xml).toContain("<Encrypt>");
		const m = /<Encrypt><!\[CDATA\[(.+?)\]\]><\/Encrypt>/.exec(xml);
		expect(m).toBeTruthy();
		const plain = decrypt(AES_KEY, m![1]);
		expect(plain.message).toBe("ok");
	});
});
