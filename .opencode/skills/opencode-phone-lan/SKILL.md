---
name: opencode-phone-lan
description: Connect a phone browser on trusted home Wi-Fi to the existing OpenCode Desktop server on Windows. Use for local pairing, a bookmarkable Web URL, and diagnosing why a phone cannot reach OpenCode.
---

Use the existing Desktop background service so the phone sees the same sessions. This is LAN access. The Desktop **Pair device** button uses OpenTunnel for internet access and can fail before producing a QR if the tunnel certificate is still being issued. LAN pairing does not use that tunnel.

1. Locate the CLI. If `Get-Command opencode` finds nothing, look for `opencode-cli.exe` under `$env:APPDATA\ai.opencode.desktop\cli`. Prefer the executable of the running OpenCode service, which you can identify from the listening process. Run it by full path with PowerShell's call operator (`&`). Keep the app's existing service and its authentication.
2. Check `service status`, `service get hostname`, and `service get remote`. Use `Get-NetIPConfiguration` and `Get-NetConnectionProfile` to identify the PC's home adapter, IPv4 address, subnet and active firewall profile. Use the actual service port (usually 28894 on Windows). If the LAN URL already works on the phone, skip network changes and reuse the bookmark.
3. If LAN access is authorized and the service listens only on loopback, allow the actual executable and TCP port in Windows Firewall before changing the bind address. Scope the inbound rule to the current home subnet, local Wi-Fi address, interface and active profile. This requires administrator access. Reuse an existing matching rule and avoid adding overlapping rules or changing the Windows network profile. Example for a confirmed home network that Windows labels Public:

   ```powershell
   # Substitute the verified executable, IP, subnet, interface, profile, and port.
   New-NetFirewallRule -Name 'Codex-OpenCode-Home-WiFi' -DisplayName 'OpenCode Web - Home WiFi' `
     -Direction Inbound -Action Allow -Protocol TCP -LocalPort 28894 `
     -LocalAddress '192.168.1.9' -RemoteAddress '192.168.1.0/24' `
     -InterfaceAlias 'WiFi' -Profile Public -Program $cli
   ```

   Once the scoped rule is in place, run `& $cli service set hostname 0.0.0.0` and then `& $cli service start` if the setting change succeeded. Changing the hostname stops the existing service, so verify it starts again. Do not enable OpenTunnel, add router port forwarding, or remove authentication for a LAN-only request. To undo this setup, restore the original hostname (use `service unset hostname` if it was unset), start the service and remove only the firewall rule created for this setup.
4. From the PC, verify that both the loopback URL and the Wi-Fi URL return the expected HTTP response. A response on the PC does not prove the phone can cross the firewall. Have the user open the same IP and port on the phone while connected to the same Wi-Fi. If the PC works and the phone cannot connect, check the active firewall scope, current IP, and whether the phone is on a guest network or a Wi-Fi network with device isolation.
5. If the phone browser is already signed in, open the base URL. Otherwise, run `& $cli pair --url $lanUrl` in a visible local terminal so the user can scan the QR or open the printed link directly on the phone. The link is a sign-in credential, valid once for five minutes. Keep it out of agent transcripts, logs, repositories and shared screenshots. Never bookmark the pairing link.

After sign-in, bookmark the base URL (for example, `http://192.168.1.9:28894`). The same browser retains its sign-in cookie for up to 30 days; clearing it or changing the server password requires signing in again. The LAN URL stays the same while the PC's IP and port stay the same and the service is running. A DHCP reservation on the home router keeps the IP stable; change router settings only if requested. If Windows, the adapter, or the bundled CLI changes, recheck the scoped firewall rule. OpenCode Web gives access to the server's sessions; Desktop-only GUI plugins such as TreeRail require the Desktop app.

References: [OpenCode Web](https://opencode.ai/docs/cli/web), [pair and service commands](https://opencode.ai/docs/cli/commands#pair), [Desktop pairing implementation](https://github.com/anomalyco/opencode/pull/55306).
