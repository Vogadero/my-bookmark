import * as crypto from "crypto";
import * as vscode from "vscode";

export class CryptoHelper {
    private algorithm = "aes-256-cbc";
    private ivLength = 16;

    public async encrypt(text: string): Promise<string> {
        try {
            const key = await this.getKey();
            const iv = crypto.randomBytes(this.ivLength);
            const cipher = crypto.createCipheriv(this.algorithm, key, iv);
            let encrypted = cipher.update(text, "utf8", "hex");
            encrypted += cipher.final("hex");
            return iv.toString("hex") + ":" + encrypted;
        } catch (error) {
            const errorMsg = `加密失败: ${error instanceof Error ? error.message : error}`;
            throw new Error(errorMsg); // 向上抛出更详细的错误
        }
    }

    public async decrypt(text: string): Promise<string> {
        try {
            const key = await this.getKey();
            const [ivHex, encrypted] = text.split(":");
            const iv = Buffer.from(ivHex, "hex");
            const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
            let decrypted = decipher.update(encrypted, "hex", "utf8");
            decrypted += decipher.final("utf8");
            return decrypted;
        } catch (error) {
            const errorMsg = `解密失败: ${error instanceof Error ? error.message : error}`;
            throw new Error(errorMsg); // 向上抛出更详细的错误
        }
    }

    private async getKey(): Promise<Buffer> {
        const config = vscode.workspace.getConfiguration("bookmark");
        let key = config.get<string>("encryptionKey") || "";

        if (!key) {
            key = this.generateKey();
            await config.update("encryptionKey", key, true);
        }

        return crypto.createHash("sha256").update(key).digest();
    }

    public generateKey(): string {
        return crypto.randomBytes(32).toString("base64").slice(0, 32);
    }
}
