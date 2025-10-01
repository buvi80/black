import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { google } from "googleapis";
import fs from "fs-extra";
// =================== GOOGLE DRIVE SETUP ===================
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/drive"]
})
const drive = google.drive({ version: "v3", auth })

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

function extractFileId(url) {
  const regex = /[-\w]{25,}/
  const match = url.match(regex)
  return match ? match[0] : null
}

// =================== FILE SPLITTING ===================
async function splitFile(filePath, chunkSizeMB = 95) {
  const stats = await fs.stat(filePath)
  const totalSize = stats.size
  const chunkSize = chunkSizeMB * 1024 * 1024

  const chunks = []
  const readStream = fs.createReadStream(filePath, { highWaterMark: chunkSize })
  let part = 0

  for await (const chunk of readStream) {
    part++
    const partPath = `${filePath}.part${part}`
    await fs.writeFile(partPath, chunk)
    chunks.push(partPath)
  }

  return chunks
}

// =================== WHATSAPP BOT ===================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  })

  // Pair Code (First time only)
  if (!state.creds.registered) {
    const phoneNumber = "94775090172"   // <-- change this
    const code = await sock.requestPairingCode(phoneNumber)
    console.log("📌 Pair Code:", code)
    console.log("👉 WhatsApp → Linked Devices → Link with phone number → Enter code")
  }

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

      const metadata = await drive.files.get({ fileId, fields: "name, size" })
      const fileName = metadata.data.name
      const fileSize = parseInt(metadata.data.size)

      const filePath = path.join("./downloads", fileName)
      await sock.sendMessage(msg.key.remoteJid, { text: `📥 Downloading ${fileName} (${(fileSize/1024/1024).toFixed(2)} MB)...` })

      await downloadFile(fileId, filePath)

      // Split if larger than 95MB
      let filesToSend = []
      if (fileSize > 95 * 1024 * 1024) {
        filesToSend = await splitFile(filePath, 95)
        await sock.sendMessage(msg.key.remoteJid, {
          text: `⚠️ File too large. Split into ${filesToSend.length} parts.`
        })
      } else {
        filesToSend = [filePath]
      }

      // Send chunks
      for (let i = 0; i < filesToSend.length; i++) {
        const partPath = filesToSend[i]
        await sock.sendMessage(msg.key.remoteJid, {
          document: { url: partPath },
          fileName: path.basename(partPath),
          mimetype: "application/octet-stream"
        })
        await new Promise(res => setTimeout(res, 3000)) // delay between sends
      }

      await sock.sendMessage(msg.key.remoteJid, {
        text: `✅ Done! Received in ${filesToSend.length} parts.\nUse 7zip / "cat file.part* > file" to join.`
      })
    }
  })

  sock.ev.on("connection.update", (update) => {
    if (update.connection === "open") console.log("✅ Bot Connected!")
  })

  sock.ev.on("creds.update", saveCreds)
}

startBot().catch(console.error)
