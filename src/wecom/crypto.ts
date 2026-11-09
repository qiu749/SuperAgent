/**
 * 企业微信回调加解密（SPEC §3）：AES-256-CBC + PKCS#7(32) + SHA1 签名。
 * 协议：明文 = random(16B) + msg_len(4B 大端) + msg + receiveid；密文 Base64。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const BLOCK = 32;

export class WeComCryptoError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function aesKeyFromEncodingKey(encodingAesKey: string): Buffer {
	const key = Buffer.from(encodingAesKey + "=", "base64");
	if (key.length !== 32) {
		throw new WeComCryptoError("invalid_aes_key", `EncodingAESKey 非法：解码后须为 32 字节，实际 ${key.length}`);
	}
	return key;
}

/** PKCS#7(BLOCK=32) 去填充。 */
function pkcs7Unpad(buf: Buffer): Buffer {
	const pad = buf[buf.length - 1];
	if (pad < 1 || pad > BLOCK || buf.length < pad) {
		throw new WeComCryptoError("bad_padding", "PKCS#7 填充非法");
	}
	for (let i = buf.length - pad; i < buf.length; i++) {
		if (buf[i] !== pad) throw new WeComCryptoError("bad_padding", "PKCS#7 填充非法");
	}
	return buf.subarray(0, buf.length - pad);
}

function pkcs7Pad(buf: Buffer): Buffer {
	const pad = BLOCK - (buf.length % BLOCK);
	return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/** 回调验签：sha1(sort(token, timestamp, nonce, encrypt))。 */
export function verifySignature(token: string, timestamp: string, nonce: string, encrypt: string, signature: string): boolean {
	const expected = signatureOf(token, timestamp, nonce, encrypt);
	return expected === signature;
}

export function signatureOf(token: string, timestamp: string, nonce: string, encrypt: string): string {
	return createHash("sha1")
		.update([token, timestamp, nonce, encrypt].sort().join(""))
		.digest("hex");
}

/** 解密回调密文；receiveid 用于企业号校验（corpId 或消息主体）。 */
export function decrypt(encodingAesKey: string, encryptB64: string): { message: string; receiveId: string } {
	const key = aesKeyFromEncodingKey(encodingAesKey);
	const cipher = Buffer.from(encryptB64, "base64");
	if (cipher.length === 0 || cipher.length % BLOCK !== 0) {
		throw new WeComCryptoError("bad_cipher", "密文长度非法");
	}
	const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
	decipher.setAutoPadding(false);
	const plain = pkcs7Unpad(Buffer.concat([decipher.update(cipher), decipher.final()]));
	if (plain.length < 20) {
		throw new WeComCryptoError("bad_plain", "明文过短");
	}
	const msgLen = plain.readUInt32BE(16);
	if (msgLen + 20 > plain.length) {
		throw new WeComCryptoError("bad_plain", "明文长度字段非法");
	}
	const message = plain.subarray(20, 20 + msgLen).toString("utf8");
	const receiveId = plain.subarray(20 + msgLen).toString("utf8");
	return { message, receiveId };
}

/** 加密回复（GET 验证与 POST 响应）。 */
export function encrypt(encodingAesKey: string, message: string, receiveId: string): string {
	const key = aesKeyFromEncodingKey(encodingAesKey);
	const random = randomBytes(16);
	const msgBuf = Buffer.from(message, "utf8");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(msgBuf.length, 0);
	const plain = pkcs7Pad(Buffer.concat([random, len, msgBuf, Buffer.from(receiveId, "utf8")]));
	const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

/** 构造回调响应包。 */
export function packReply(token: string, encodingAesKey: string, corpId: string, message: string, timestamp: string, nonce: string): string {
	const encryptB64 = encrypt(encodingAesKey, message, corpId);
	const signature = signatureOf(token, timestamp, nonce, encryptB64);
	return `<xml><Encrypt><![CDATA[${encryptB64}]]></Encrypt><MsgSignature><![CDATA[${signature}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
}
