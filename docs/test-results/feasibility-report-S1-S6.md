# NetSwitch — Complete Feasibility Testing Report (S1–S6)

Before starting the actual NetSwitch development, we performed six feasibility tests on your Windows 11 laptop to verify whether the core networking concepts required by the project would work in practice.

The purpose was to validate the Windows networking behaviour, adapter switching possibilities, packet-level traffic, network impairment, Wi-Fi scanning and recovery mechanisms before implementing them in Node.js and React.

Your project uses:

- Operating System: Windows 11
- Laptop: Lenovo Legion 5
- Wi-Fi Adapter: Intel Wi-Fi 6 AX203
- USB Tether Adapter: Remote NDIS — Ethernet 2
- Backend (planned): Node.js + Express
- Frontend (planned): React
- Database (planned): MySQL

An important distinction: these were manual feasibility experiments. We have not yet implemented the complete NetSwitch application or its automatic switching agent.

## 1. Initial network configuration

We first identified the two physical network adapters that NetSwitch will use.

| Property         | Wi-Fi               | USB tether      |
| ---------------- | ------------------- | --------------- |
| Adapter name     | Wi-Fi               | Ethernet 2      |
| Interface index  | 12                  | 17              |
| Adapter hardware | Intel Wi-Fi 6 AX203 | Remote NDIS     |
| IPv4 address     | `10.97.128.167`     | `10.41.171.54`  |
| Default gateway  | `10.97.128.135`     | `10.41.171.250` |
| Interface metric | 75                  | 5               |
| Automatic metric | Disabled            | Disabled        |

We used:

```
Get-NetIPConfiguration
```

And:

```
Get-NetIPInterface -AddressFamily IPv4
```

### What did we learn?

Windows uses interface metrics when choosing between competing routes.

A lower metric generally means a more preferred route when other route-selection factors are equal.

Our configuration was:

- USB tether: metric 5 — preferred.
- Wi-Fi: metric 75 — secondary.

This was useful because we could test Wi-Fi independently while leaving USB as the normal preferred connection.

## 2. S1 — Windows host-route feasibility

Passed

Objective: Verify whether Windows can direct traffic to particular destinations through a specified network adapter, regardless of the normal default-route preference.

### What we performed

We created two temporary `/32` host routes.

A `/32` route applies to one specific IPv4 destination.

First, we directed `1.1.1.1` through Wi-Fi:

```
New-NetRoute `
-DestinationPrefix "1.1.1.1/32" `
-InterfaceIndex 12 `
-NextHop "10.97.128.135" `
-PolicyStore ActiveStore
```

Then, we directed `8.8.8.8` through USB:

```
New-NetRoute `
-DestinationPrefix "8.8.8.8/32" `
-InterfaceIndex 17 `
-NextHop "10.41.171.250" `
-PolicyStore ActiveStore
```

We verified the selected routes using:

```
Find-NetRoute -RemoteIPAddress 1.1.1.1
```

And:

```
Find-NetRoute -RemoteIPAddress 8.8.8.8
```

### What happened?

| Destination | Selected adapter | Result  |
| ----------- | ---------------- | ------- |
| `1.1.1.1`   | Wi-Fi            | Correct |
| `8.8.8.8`   | Ethernet 2       | Correct |

Both TCP connectivity tests to port 443 succeeded.

Afterward, we reversed the default interface metrics:

- Wi-Fi: 5
- USB: 75

The two specific destination routes continued selecting their assigned interfaces.

### What did we prove?

We verified that Windows supports destination-specific routing through different physical adapters even when the default route preference changes.

This is important for NetSwitch because it allows us to probe a standby connection without changing the entire system's default route.

Final S1 conclusion: Host-route-based adapter selection is feasible on your Windows system.

## 3. S2 — Node.js source binding and Wireshark packet verification

Passed

Objective: Verify that a Node.js TCP connection can use the intended Wi-Fi source address and inspect the actual packets on both adapters.

This was one of the most important tests because we wanted to go beyond simply checking whether a connection succeeded.

### What we performed

We created a temporary host route for:

```
1.1.1.1/32 → Wi-Fi
```

Then we wrote a small Node.js TCP test.

The important code was:

```
const net = require("net");

const options = {
    host: "1.1.1.1",
    port: 443,
    localAddress: "10.97.128.167",
    timeout: 5000
};

const socket = net.createConnection(options);

socket.on("connect", () => {
    console.log("CONNECTION SUCCESSFUL");
    console.log("Local address:", socket.localAddress);
    console.log("Remote address:", socket.remoteAddress);
    socket.end();
});

socket.on("error", (error) => {
    console.error("CONNECTION FAILED:", error.message);
});
```

The key parameter was:

```
localAddress: "10.97.128.167"
```

This binds the socket to the Wi-Fi IPv4 source address.

### Node.js result

The connection succeeded.

| Property       | Result          |
| -------------- | --------------- |
| Destination    | `1.1.1.1:443`   |
| Local address  | `10.97.128.167` |
| Remote address | `1.1.1.1`       |
| Connection     | Successful      |

### Wireshark verification

We used:

- Wireshark 4.6.9
- Npcap 1.88

We captured traffic separately on the Wi-Fi and Ethernet 2 interfaces.

The display filter was:

```
tcp.flags.syn == 1 &&
tcp.flags.ack == 0 &&
ip.dst == 1.1.1.1 &&
tcp.dstport == 443
```

Wi-Fi capture

SYN packet observed

- Source IP: `10.97.128.167`
- Destination IP: `1.1.1.1`
- Destination port: `443`
- TCP SYN packet observed.

Ethernet 2 capture

No matching SYN packet

- Packets captured: 516
- Matching packets: 0
- Dropped capture packets: 0

We ran the Node.js connection while the Ethernet 2 capture was active.

### What did we prove?

The connection used the intended Wi-Fi path in this test setup, supported by:

1. The temporary destination-specific route.
2. The Node.js socket's local address.
3. The SYN packet observed on Wi-Fi.
4. No matching SYN packet observed on Ethernet 2.

An important technical distinction: `localAddress` alone does not force a physical network interface. It selects the source address. The host route and packet capture provide the additional routing evidence.

Final S2 conclusion: Node.js socket binding combined with Windows host routes and packet capture provides a feasible method for validating adapter-specific traffic.

## 4. S3 — Adapter disconnection and recovery

Passed

Objective: Verify that internet connectivity can continue through the remaining adapter when one network adapter is disconnected.

We tested both directions.

### Test A — Disconnect Wi-Fi

First, both adapters were connected.

We ran:

```
Test-NetConnection 8.8.8.8 -Port 443
```

The connection used Ethernet 2.

Then we disabled Wi-Fi:

```
Disable-NetAdapter -Name "Wi-Fi" -Confirm:$false
```

We checked the adapter status and repeated the TCP connectivity test.

Result: USB tether continued working.

Next, we enabled Wi-Fi:

```
Enable-NetAdapter -Name "Wi-Fi"
```

The adapter initially showed `Disconnected`.

We manually selected the mobile hotspot in the Windows Wi-Fi interface to reconnect it.

Important finding: Enabling a Wi-Fi adapter does not necessarily reconnect it to its previous SSID automatically.

### Test B — Disconnect USB tether

We then disabled Ethernet 2:

```
Disable-NetAdapter -Name "Ethernet 2" -Confirm:$false
```

Wi-Fi remained connected.

We tested:

```
Test-NetConnection 1.1.1.1 -Port 443
```

The connection succeeded through Wi-Fi.

Finally, we enabled Ethernet 2 again:

```
Enable-NetAdapter -Name "Ethernet 2"
```

Both adapters returned to the Up state.

### S3 results

| Scenario                          | Result                       |
| --------------------------------- | ---------------------------- |
| Wi-Fi disconnected, USB available | Internet worked              |
| USB disconnected, Wi-Fi available | Internet worked              |
| Wi-Fi re-enabled                  | Required manual reconnection |
| USB re-enabled                    | Adapter returned to Up       |

### What did we prove?

Windows can continue using the remaining connected adapter when one adapter goes down.

However, we did not test automatic monitoring or failover by a NetSwitch application. That logic still needs implementation.

## 5. S4 — Controlled network impairment using Clumsy

Passed

Objective: Introduce artificial latency and packet loss on Wi-Fi and verify whether our network measurements can detect the degradation.

This test was particularly important because NetSwitch is supposed to detect poor network quality, not merely whether an adapter is connected.

### 5.1 Installing and configuring Clumsy

We downloaded Clumsy 0.3 for 64-bit Windows:

```
clumsy-0.3-win64-a.zip
```

We extracted it into:

```
D:\TY (5th Sem)\CNT\CP\NetSwitch\tools\clumsy
```

Then we launched `clumsy.exe` as Administrator.

Clumsy uses packet interception to introduce artificial network conditions.

### 5.2 Configuring the Wi-Fi filter

Our Wi-Fi IP was:

```
10.97.128.167
```

We configured the filter:

```
ip and (ip.SrcAddr == 10.97.128.167 or ip.DstAddr == 10.97.128.167)
```

This selects IPv4 packets where the Wi-Fi IP is the source or destination.

We started filtering with all impairment options disabled first.

The status displayed:

```
Started filtering. Enable functionalities to take effect.
```

This confirmed that packet filtering had started.

### 5.3 Establishing the baseline

Initially, Windows preferred USB tether because its metric was 5.

We therefore created a temporary Wi-Fi-specific host route:

```
New-NetRoute `
-DestinationPrefix "1.1.1.1/32" `
-InterfaceIndex 12 `
-NextHop "10.97.128.135" `
-PolicyStore ActiveStore
```

We verified the route:

```
Find-NetRoute -RemoteIPAddress 1.1.1.1
```

It selected:

```
InterfaceAlias : Wi-Fi
InterfaceIndex : 12
IPAddress      : 10.97.128.167
```

We also checked TCP connectivity:

```
Test-NetConnection 1.1.1.1 -Port 443
```

Result:

```
InterfaceAlias   : Wi-Fi
SourceAddress    : 10.97.128.167
TcpTestSucceeded : True
```

For the baseline measurement, we ran:

```
ping.exe -n 30 1.1.1.1
```

Normal Wi-Fi — Baseline

# 0%

Packet loss

# 37 ms

Average RTT

30 / 30

Packets received

24–234 ms

RTT range

### 5.4 Applying network impairment

We configured Clumsy as follows:

| Parameter    | Value    |
| ------------ | -------- |
| Filter       | Wi-Fi IP |
| Lag          | 150 ms   |
| Drop         | 10%      |
| Inbound      | Enabled  |
| Outbound     | Enabled  |
| Duplicate    | Disabled |
| Out of order | Disabled |
| Tamper       | Disabled |
| Bandwidth    | Disabled |

We then started Clumsy.

We performed two TCP connectivity checks.

Wi-Fi test:

```
Test-NetConnection 1.1.1.1 -Port 443
```

Result:

```
InterfaceAlias   : Wi-Fi
SourceAddress    : 10.97.128.167
TcpTestSucceeded : True
```

USB test:

```
Test-NetConnection 8.8.8.8 -Port 443
```

Result:

```
InterfaceAlias   : Ethernet 2
SourceAddress    : 10.41.171.54
TcpTestSucceeded : True
```

Both TCP connections succeeded.

However, TCP can retransmit lost packets, so connection success alone was insufficient to measure impairment.

### 5.5 Measuring the actual impairment

We repeated the 30-packet Wi-Fi ping:

```
ping.exe -n 30 1.1.1.1
```

Impaired Wi-Fi — Clumsy enabled

# 20%

Packet loss

# 378 ms

Average RTT

24 / 30

Packets received

341–420 ms

RTT range

### 5.6 Comparison

| Metric      | Normal | Impaired |
| ----------- | ------ | -------- |
| Sent        | 30     | 30       |
| Received    | 30     | 24       |
| Lost        | 0      | 6        |
| Packet loss | 0%     | 20%      |
| Minimum RTT | 24 ms  | 341 ms   |
| Maximum RTT | 234 ms | 420 ms   |
| Average RTT | 37 ms  | 378 ms   |

Average Wi-Fi RTT comparison

Measured before and during Clumsy impairment, in milliseconds.

0 ms100 ms200 ms300 ms400 msNormal Wi-FiImpaired Wi-Fi

The average RTT increased by 341 ms.

The measured packet loss increased from 0% to 20%.

Why did we observe 20% packet loss when Drop was configured to 10%?

Because impairment was enabled in both inbound and outbound directions. A ping exchange can fail if either the request or its response is dropped. The observed result is plausible, although it is not guaranteed to equal a particular theoretical probability.

### 5.7 Cleanup

After collecting the results, we stopped Clumsy.

We removed the temporary Wi-Fi host route:

```
Remove-NetRoute `
-DestinationPrefix "1.1.1.1/32" `
-InterfaceIndex 12 `
-NextHop "10.97.128.135" `
-Confirm:$false
```

We verified:

```
Get-NetRoute -DestinationPrefix "1.1.1.1/32" -ErrorAction SilentlyContinue
```

No route was returned.

Finally:

```
Find-NetRoute -RemoteIPAddress 1.1.1.1
```

Windows returned Ethernet 2 as the preferred route.

S4 conclusion: We successfully demonstrated controlled Wi-Fi degradation and measured the resulting latency and packet loss. We did not independently measure USB ping performance during the same impairment period, so USB isolation was not fully quantified.

## 6. S5 — Read-only Wi-Fi network scanning

Passed

Objective: Verify that Windows can discover nearby Wi-Fi networks and retrieve their wireless properties without connecting to them.

### What we performed

We ran:

```
netsh wlan show networks mode=bssid
```

This is a read-only Wi-Fi scan.

### Actual result

Windows detected one visible network.

| Property        | Result              |
| --------------- | ------------------- |
| SSID            | Moto g64 5G         |
| Network type    | Infrastructure      |
| Authentication  | WPA3-Personal       |
| Encryption      | CCMP                |
| BSSID           | `66:71:2f:94:31:f9` |
| Signal strength | 97%                 |
| Radio type      | 802.11ac            |
| Band            | 2.4 GHz             |
| Channel         | 1                   |

### What did we prove?

We confirmed that Windows can discover nearby Wi-Fi networks and expose:

- Network name (SSID)
- Access point identifier (BSSID)
- Signal strength
- Authentication method
- Encryption type
- Radio type
- Frequency band
- Channel

This can be used later in NetSwitch to display available Wi-Fi network information in a read-only dashboard.

### Important limitation

We detected only one network during this scan.

We did not test multiple access points or multiple SSIDs in a crowded environment.

We also did not connect to or actively test any other nearby network.

S5 conclusion: Read-only Wi-Fi discovery is feasible using the built-in Windows networking commands.

## 7. S6 — Recovery script and network configuration restoration

Manual recovery passed

Objective: Establish a manual recovery mechanism that restores the original adapter metrics if a network configuration is left in an unexpected state.

This test needs an important distinction: we did not yet simulate a real NetSwitch agent crash because the agent has not been implemented.

### 7.1 Recording the original metrics

We ran:

```
Get-NetIPInterface -AddressFamily IPv4 |
Where-Object {$_.InterfaceAlias -in @("Wi-Fi","Ethernet 2")} |
Format-Table InterfaceAlias, InterfaceIndex, AutomaticMetric, InterfaceMetric
```

Output:

| Adapter    | Automatic metric | Interface metric |
| ---------- | ---------------- | ---------------- |
| Ethernet 2 | Disabled         | 5                |
| Wi-Fi      | Disabled         | 75               |

### 7.2 Recording default routes

We ran:

```
Get-NetRoute -AddressFamily IPv4 |
Where-Object {$_.DestinationPrefix -eq "0.0.0.0/0"} |
Format-Table InterfaceAlias, InterfaceIndex, DestinationPrefix, NextHop, RouteMetric
```

Result:

| Adapter    | Default gateway | Route metric |
| ---------- | --------------- | ------------ |
| Ethernet 2 | `10.41.171.250` | 5            |
| Wi-Fi      | `10.97.128.135` | 75           |

This established the expected network configuration.

### 7.3 Checking the recovery script

We checked whether the following file existed:

```
D:\TY (5th Sem)\CNT\CP\NetSwitch\restore.ps1
```

Initially, it did not exist.

We then created it.

The script was:

```
$ErrorActionPreference = "Stop"

Write-Host "Restoring NetSwitch network configuration..."

Set-NetIPInterface -InterfaceAlias "Ethernet 2" `
-AddressFamily IPv4 `
-AutomaticMetric Disabled `
-InterfaceMetric 5

Set-NetIPInterface -InterfaceAlias "Wi-Fi" `
-AddressFamily IPv4 `
-AutomaticMetric Disabled `
-InterfaceMetric 75

Write-Host "`nVerifying restored metrics..."

Get-NetIPInterface -AddressFamily IPv4 |
Where-Object {$_.InterfaceAlias -in @("Wi-Fi","Ethernet 2")} |
Format-Table InterfaceAlias, InterfaceIndex, AutomaticMetric, InterfaceMetric

Write-Host "`nRecovery script completed."
```

We verified the file existed:

```
Test-Path "D:\TY (5th Sem)\CNT\CP\NetSwitch\restore.ps1"
```

Output:

```
True
```

We also inspected its contents using:

```
Get-Content "D:\TY (5th Sem)\CNT\CP\NetSwitch\restore.ps1"
```

### 7.4 Executing the recovery script

We ran:

```
& "D:\TY (5th Sem)\CNT\CP\NetSwitch\restore.ps1"
```

Actual output:

```
Restoring NetSwitch network configuration...

Verifying restored metrics...

InterfaceAlias InterfaceIndex AutomaticMetric InterfaceMetric
-------------- -------------- --------------- ---------------
Ethernet 2                 17        Disabled               5
Wi-Fi                      12        Disabled              75

Recovery script completed.
```

### What did we prove?

We successfully created and executed a manual PowerShell recovery script that restores:

- Ethernet 2 metric to 5.
- Wi-Fi metric to 75.
- Automatic metric to Disabled.

What remains untested: Automatic recovery when the actual NetSwitch process crashes, restoration after an unexpected laptop shutdown, startup recovery, and recovery from an agent failure between changing the metric and verifying the new route.

S6 conclusion: Manual recovery is verified. Automatic crash recovery remains a development requirement.

## 8. Final summary of all six tests

## NetSwitch feasibility results

S1 — Host-route feasibility

Passed

Windows successfully routed individual destinations through specific adapters.

S2 — Node.js and packet verification

Passed

Node.js connected using the Wi-Fi source address, and Wireshark confirmed the expected packet path.

S3 — Adapter disconnection

Passed

Connectivity continued through the remaining adapter. Wi-Fi required manual reconnection.

S4 — Network impairment

Passed

Clumsy introduced measurable latency and packet loss on Wi-Fi.

S5 — Wi-Fi scanning

Passed

Windows successfully discovered and displayed nearby wireless network information.

S6 — Manual recovery

Passed

The PowerShell recovery script restored the original network metrics. Actual agent crash recovery is still pending.

## 9. What have we actually achieved?

The most important outcome is that we have experimentally validated several technical assumptions behind NetSwitch.

| Project requirement                         | Feasibility evidence |
| ------------------------------------------- | -------------------- |
| Select a specific adapter for a destination | S1                   |
| Probe through a particular source IP        | S2                   |
| Verify actual network traffic               | S2                   |
| Handle adapter disconnection scenarios      | S3                   |
| Detect latency degradation                  | S4                   |
| Detect packet loss                          | S4                   |
| Discover nearby Wi-Fi networks              | S5                   |
| Restore original interface metrics          | S6                   |

These tests reduce implementation risk, but they do not establish that the full application is ready.

## 10. What we have NOT implemented yet

This is particularly important when explaining the project's progress to your faculty.

| Component                                | Current status  |
| ---------------------------------------- | --------------- |
| React dashboard                          | Not implemented |
| Express backend                          | Not implemented |
| Automatic adapter discovery              | Not implemented |
| Continuous per-adapter probes            | Not implemented |
| UDP/DNS measurement engine               | Not implemented |
| Latency and jitter calculation engine    | Not implemented |
| Packet-loss calculation engine           | Not implemented |
| Network scoring formula                  | Not implemented |
| Automatic decision engine                | Not implemented |
| Automatic failover                       | Not implemented |
| Metric switching and rollback controller | Not implemented |
| Automatic route verification             | Not implemented |
| MySQL persistence                        | Not implemented |
| WebSocket live updates                   | Not implemented |
| JWT authentication                       | Not implemented |
| Automatic agent crash recovery           | Not implemented |

We have manually validated the underlying Windows capabilities. The next phase is to implement these capabilities in the actual application.

## 11. Suggested explanation for your faculty review

Here is a concise script you can use to explain what you accomplished.

### NetSwitch — Feasibility Testing Explanation

Before starting the actual implementation, we performed six feasibility tests to validate whether our proposed network-switching architecture would work on Windows.

First, we tested Windows host routing. We created temporary destination-specific routes and verified that traffic to different IP addresses could be directed through Wi-Fi and USB tether independently, even when the default interface metric was changed.

Second, we tested Node.js socket binding. We created a TCP connection using the Wi-Fi source IP and verified the traffic using Wireshark. We observed the SYN packet on the Wi-Fi interface and did not observe the matching packet on the USB interface.

Third, we tested adapter disconnection. We disconnected Wi-Fi and verified that USB tether continued providing internet connectivity. We then disconnected USB and verified that Wi-Fi continued working. We also observed that Wi-Fi required manual reconnection after enabling the adapter.

Fourth, we tested network degradation using Clumsy. We configured 150 milliseconds of artificial lag and 10% packet dropping in both directions, restricted to our Wi-Fi IP. Before impairment, Wi-Fi had 0% packet loss and 37 ms average latency. During impairment, packet loss increased to 20% and average latency increased to 378 ms. This demonstrated that our system can use measurable network-quality changes to identify degradation.

Fifth, we tested read-only Wi-Fi scanning using Windows netsh commands. We successfully retrieved the SSID, signal strength, authentication type, frequency band and channel of the connected hotspot.

Finally, we created and tested a PowerShell recovery script that restores the original interface metrics of USB to 5 and Wi-Fi to 75.

Overall, these experiments validated the main Windows networking capabilities required by NetSwitch. We have completed the initial feasibility phase and are now ready to start implementing the backend, probing engine, scoring engine, decision logic and frontend.

One limitation is that automatic switching and automatic crash recovery have not yet been implemented. Those will be validated during application development.

## 12. My recommendation: Preserve the experimental evidence

Before beginning backend development, save these results under your existing project directory:

```
NetSwitch/
└── docs/
    └── test-results/
        ├── S1-host-route-feasibility.md
        ├── S2-node-wireshark-verification.md
        ├── S3-adapter-disconnection.md
        ├── S4-network-impairment.md
        ├── S5-wifi-scanning.md
        ├── S6-manual-recovery.md
        └── feasibility-summary.md
```

Include the PowerShell outputs and screenshots, especially the Wireshark packet evidence and Clumsy baseline-versus-impaired results.

My overall assessment: The feasibility phase has provided strong practical evidence for the Windows networking foundation of NetSwitch. The next major challenge is integrating these individually tested capabilities into one reliable application with continuous monitoring, automatic decisions, safe switching, rollback and recovery.