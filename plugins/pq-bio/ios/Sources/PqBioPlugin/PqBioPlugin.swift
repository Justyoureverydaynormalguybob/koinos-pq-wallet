import Foundation
import Capacitor
import LocalAuthentication
import Security

/// A 32-byte key kept in the Keychain behind the device's biometric: the item is created with
/// kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly and the biometryCurrentSet access control, so it
/// never leaves this device, never enters a backup, is readable only after Face ID / Touch ID passes,
/// and is gone the moment the enrolled set of faces or fingers changes. Writing it asks nothing;
/// reading it shows the system prompt. Errors say "cancelled", "invalidated" or "failed".
@objc(PqBioPlugin)
public class PqBioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PqBioPlugin"
    public let jsName = "PqBio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let service = "ie.rawbyte.koinospq.kwk"
    private let account = "kwk"

    private func baseQuery() -> [String: Any] {
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    @objc func available(_ call: CAPPluginCall) {
        let ctx = LAContext()
        var err: NSError?
        let ok = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        call.resolve(["available": ok])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let hex = call.getString("hex"), hex.count == 64, let data = Data(hex: hex) else {
            call.reject("failed: bad key")
            return
        }
        SecItemDelete(baseQuery() as CFDictionary)
        var acErr: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &acErr) else {
            call.reject("failed: access control")
            return
        }
        var q = baseQuery()
        q[kSecAttrAccessControl as String] = access
        q[kSecValueData as String] = data
        let status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecSuccess { call.resolve() } else { call.reject("failed: \(status)") }
    }

    @objc func remove(_ call: CAPPluginCall) {
        SecItemDelete(baseQuery() as CFDictionary)
        call.resolve()
    }

    @objc func get(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Unlock the wallet"
        DispatchQueue.global(qos: .userInitiated).async {
            let ctx = LAContext()
            ctx.localizedReason = reason
            ctx.localizedCancelTitle = call.getString("cancel")
            var q = self.baseQuery()
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            q[kSecUseAuthenticationContext as String] = ctx
            q[kSecUseOperationPrompt as String] = reason
            var out: CFTypeRef?
            let status = SecItemCopyMatching(q as CFDictionary, &out)
            switch status {
            case errSecSuccess:
                guard let d = out as? Data else { call.reject("failed: no data"); return }
                call.resolve(["hex": d.map { String(format: "%02x", $0) }.joined()])
            case errSecItemNotFound:
                // either never set, or invalidated by an enrolment change (the system removes the item)
                call.resolve(["hex": NSNull()])
            case errSecUserCanceled, errSecAuthFailed:
                call.reject(status == errSecUserCanceled ? "cancelled" : "failed: biometric did not pass")
            default:
                call.reject("failed: \(status)")
            }
        }
    }
}

private extension Data {
    init?(hex: String) {
        var bytes = [UInt8]()
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            guard let b = UInt8(hex[i..<j], radix: 16) else { return nil }
            bytes.append(b)
            i = j
        }
        self.init(bytes)
    }
}
