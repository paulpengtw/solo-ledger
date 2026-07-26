import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <rect width="512" height="512" rx="112" fill="#17342d"/>
  <circle cx="256" cy="256" r="166" fill="#a8ef76"/>
  <text x="256" y="330" font-family="-apple-system, 'PingFang TC', sans-serif"
        font-size="210" font-weight="800" fill="#17342d" text-anchor="middle">帳</text>
</svg>`

mkdirSync('public/icons', { recursive: true })
const source = Buffer.from(svg)
await sharp(source).resize(192, 192).png().toFile('public/icons/icon-192.png')
await sharp(source).resize(512, 512).png().toFile('public/icons/icon-512.png')
await sharp(source).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png')
console.log('icons written')
