import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import wrtc from "@roamhq/wrtc";

const { RTCPeerConnection } = wrtc;

async function waitForIceGatheringComplete(peerConnection, timeoutMs = 10000) {
  if (peerConnection.iceGatheringState === "complete") {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
      reject(new Error("ICE gathering timed out"));
    }, timeoutMs);

    function onStateChange() {
      if (peerConnection.iceGatheringState === "complete") {
        clearTimeout(timeout);
        peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      }
    }

    peerConnection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

async function main() {
  const outputArg = process.argv[2] ?? "real-offer.sdp";
  const outputPath = path.resolve(process.cwd(), outputArg);

  const pc = new RTCPeerConnection({
    iceServers: []
  });

  try {
    pc.addTransceiver("audio", { direction: "sendrecv" });

    const offer = await pc.createOffer({
      offerToReceiveAudio: true
    });
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const sdp = pc.localDescription?.sdp;
    if (!sdp || !sdp.trimStart().startsWith("v=0")) {
      throw new Error("Failed to generate a valid SDP offer");
    }

    const normalizedSdp = sdp.replace(/\r?\n/g, "\r\n");
    await fs.writeFile(outputPath, normalizedSdp, { encoding: "utf8" });
    console.log(`Wrote valid SDP offer to: ${outputPath}`);
  } finally {
    pc.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
