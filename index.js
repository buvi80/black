import makeWASocket, { useMultiFileAuthState } from "@adiwajshing/baileys"
import { google } from "googleapis"
import fs from "fs-extra"
import path from "path"

// Google Drive API Setup
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/drive"]
})
const drive = google.drive({ version: "v3", auth })

// Download File from Google Drive
async function downloadFile(fileId, destPath) {
  const dest = fs.createWriteStream(destPath)
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  )
  await new Promise((resolve, reject) => {
    res.data.on("end", resolve).on("error", reject).pipe(dest)
  })
  return destPath
}

// Extract File ID from Link
function extractFileId(url) {
  const regex = /[-\w]{25,}/
  const match = url.match(regex)
  return match ? match[0] : null
}

// WhatsApp Bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true   // ✅ Show QR code in terminal
  })

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return
    const text = msg.message.conversation || ""

    if (text.startsWith(".gdrive")) {
      const link = text.split(" ")[1]
      const fileId = extractFileId(link)

      if (!fileId) {
        await sock.sendMessage(msg.key.remoteJid, { text: "❌ Invalid Google Drive link!" })
        return
      }

      // Get file info
      const metadata = await drive.files.get({ fileId, fields: "name, size" })
      const fileName = metadata.data.name
      const fileSize = parseInt(metadata.data.size)

      // WhatsApp upload limit ~100MB
      if (fileSize > 100 * 1024 * 1024) {
        await sock.sendMessage(msg.key.remoteJid, { text: `⚠️ File too large for WhatsApp (${(fileSize/1024/1024).toFixed(2)} MB)` })
        return
      }

      const filePath = path.join("./downloads", fileName)
      await sock.sendMessage(msg.key.remoteJid, { text: `📥 Downloading ${fileName}...` })

      await downloadFile(fileId, filePath)

      await sock.sendMessage(msg.key.remoteJid, {
        document: { url: filePath },
        fileName: fileName,
        mimetype: "application/octet-stream"
      })
    }
  })

  sock.ev.on("creds.update", saveCreds)
}

startBot()
