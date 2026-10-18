// The toolbar popup: the same wallet app in a 400px window. Closing the popup locks it (the
// decrypted seed lives only in this page's memory). "Open in a tab" gives the full-size page.
import "../style.css";
import { App } from "../ui/app";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app");
new App(root);

document.getElementById("open-tab")?.addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
  window.close();
});
