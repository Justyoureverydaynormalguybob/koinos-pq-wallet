import Foundation
import Capacitor
import WebKit

/// An in-app browser for dapps: a second WKWebView laid over the app's own, between a top and a
/// bottom inset in points (CSS pixels), with a script injected at document start into the main frame
/// (window.kondor and its relay) and a two-way JSON message channel. Only http(s) pages load; every
/// other scheme is dropped. The page runs in a non-persistent data store and never sees the app's
/// WebView, its storage or any key: it only ever posts JSON to the app.
@objc(PqBrowserPlugin)
public class PqBrowserPlugin: CAPPlugin, CAPBridgedPlugin, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    public let identifier = "PqBrowserPlugin"
    public let jsName = "PqBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navigate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "back", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reply", returnType: CAPPluginReturnPromise)
    ]

    private var view: WKWebView?
    private var topInset: CGFloat = 0
    private var bottomInset: CGFloat = 0

    private func isWeb(_ url: URL) -> Bool {
        return url.scheme == "https" || url.scheme == "http"
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s), isWeb(url) else {
            call.reject("only http(s) pages can be opened")
            return
        }
        let script = call.getString("script") ?? ""
        topInset = CGFloat(call.getDouble("top") ?? 0)
        bottomInset = CGFloat(call.getDouble("bottom") ?? 0)
        DispatchQueue.main.async {
            self.createView(script: script)
            self.layout()
            self.view?.load(URLRequest(url: url))
            call.resolve()
        }
    }

    @objc func navigate(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s), isWeb(url) else {
            call.reject("only http(s) pages can be opened")
            return
        }
        DispatchQueue.main.async {
            self.view?.load(URLRequest(url: url))
            call.resolve()
        }
    }

    @objc func back(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let can = self.view?.canGoBack ?? false
            if can { self.view?.goBack() }
            call.resolve(["canGoBack": can])
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.destroyView()
            call.resolve()
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.view?.isHidden = false
            call.resolve()
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.view?.isHidden = true
            call.resolve()
        }
    }

    @objc func setFrame(_ call: CAPPluginCall) {
        if let t = call.getDouble("top") { topInset = CGFloat(t) }
        if let b = call.getDouble("bottom") { bottomInset = CGFloat(b) }
        DispatchQueue.main.async {
            self.layout()
            call.resolve()
        }
    }

    /// Hands an answer to the page: window.__pqDeliver(json), defined by the injected script.
    @objc func reply(_ call: CAPPluginCall) {
        let json = call.getString("json") ?? ""
        guard let data = try? JSONSerialization.data(withJSONObject: [json]), let array = String(data: data, encoding: .utf8) else {
            call.reject("bad json")
            return
        }
        let literal = String(array.dropFirst().dropLast()) // the quoted string inside ["..."]
        DispatchQueue.main.async {
            self.view?.evaluateJavaScript("window.__pqDeliver(\(literal))", completionHandler: nil)
            call.resolve()
        }
    }

    private func createView(script: String) {
        destroyView()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        let ucc = WKUserContentController()
        ucc.add(self, name: "PqBridge")
        ucc.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        wv.backgroundColor = .white
        guard let appView = bridge?.webView, let host = appView.superview else { return }
        host.addSubview(wv)
        view = wv
    }

    /// Places the view between the insets, inside the app WebView's own frame.
    private func layout() {
        guard let wv = view, let appView = bridge?.webView else { return }
        let f = appView.frame
        wv.frame = CGRect(x: f.minX, y: f.minY + topInset, width: f.width, height: max(0, f.height - topInset - bottomInset))
    }

    private func destroyView() {
        guard let wv = view else { return }
        wv.configuration.userContentController.removeScriptMessageHandler(forName: "PqBridge")
        wv.navigationDelegate = nil
        wv.uiDelegate = nil
        wv.stopLoading()
        wv.removeFromSuperview()
        view = nil
        notifyListeners("closed", data: [:])
    }

    private func notifyNav(_ wv: WKWebView) {
        notifyListeners("navigation", data: ["url": wv.url?.absoluteString ?? "", "title": wv.title ?? "", "canGoBack": wv.canGoBack])
    }

    // MARK: WKScriptMessageHandler (the main frame only; subframes get nothing)

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "PqBridge", message.frameInfo.isMainFrame, let json = message.body as? String else { return }
        notifyListeners("message", data: ["json": json])
    }

    // MARK: WKNavigationDelegate

    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, isWeb(url) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        notifyNav(webView)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        notifyNav(webView)
    }

    // MARK: WKUIDelegate (target=_blank opens in the same view; no popups)

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, isWeb(url) {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}
