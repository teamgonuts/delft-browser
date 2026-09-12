const msg = document.getElementById("msg");
const retry = document.getElementById("retry");
async function ask() {
  retry.hidden = true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    msg.textContent = "Microphone allowed. You can close this tab and press Record in the side panel.";
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    msg.textContent = "Microphone was not allowed (" + e.message + "). Click the camera/mic icon in the address bar, allow it, then try again.";
    retry.hidden = false;
  }
}
retry.addEventListener("click", ask);
ask();
