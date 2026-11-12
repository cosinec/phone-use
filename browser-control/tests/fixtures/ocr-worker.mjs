// JSONL PaddleOCR stand-in for gateway contracts. Actual PaddleOCR is tested separately.
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (process.env.FIXTURE_OCR_ERROR) {
    process.stdout.write(JSON.stringify({ id: request.id, error: 'OCR fixture unavailable' }) + '\n');
    continue;
  }
  const bytes = Buffer.from(request.imageBase64, 'base64');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  process.stdout.write(JSON.stringify({ id: request.id, width, height, lines: [{
    text: 'Fixture screen', confidence: 0.99,
    polygon: [[0, 0], [width, 0], [width, height], [0, height]],
  }], truncated: false }) + '\n');
}
