# 📐 System Architecture Specification: RateLimit-Shield v2.0.0
- **Project:** RateLimit-Shield
- **Author:** Expert Software Architect
- **Status:** APPROVED & IN PRODUCTION
- **Version:** 2.0.0

## 1. High-Level Component Topology

```mermaid
flowchart TD
    Client["🌐 Client Microservices / Web Clients"] -->|HTTP Request| Proxy["⚡ Reverse Proxy Entrypoint (src/index.js)"]
    Proxy --> KeyExtractor["🔍 Client Identifier (IP, Header, Token)"]
    KeyExtractor --> Engine["🧠 RateLimiterEngine (src/engine.js)"]
    
    subgraph Engine["Algorithmic Execution Core"]
        direction TB
        TB["TokenBucket (O(1) Fractional Math)"]
        SW["SlidingWindow (O(k) Sub-second Log Pruner)"]
    end
    
    Engine --> Policy{"Policy Evaluator"}
    Policy -->|Allowed| Headers["Add RFC 6585 X-RateLimit-* Headers"]
    Policy -->|Exceeded| Throttle["Generate 429 Too Many Requests (Retry-After Header)"]
    
    Headers --> Response["HTTP 200 OK"]
    Throttle --> Reject["HTTP 429 Reject"]
```

## 2. Finite State Machine: Token Bucket

```mermaid
stateDiagram-v2
    [*] --> Full: Initialized with Capacity (C)
    Full --> Consuming: Request Arrives (cost = k)
    Consuming --> Depleted: Tokens == 0
    Consuming --> Refilling: Time Elapses (delta t)
    Refilling --> Full: Tokens >= C
    Refilling --> Consuming: Request Arrives
    Depleted --> Rejecting: Request Arrives (Allowed = false, Retry-After > 0)
    Depleted --> Refilling: Time Elapses
```

## 3. Concurrency Model & Memory Bounds
- **Thread Safety:** Node.js event-loop provides single-threaded deterministic execution for synchronous state updates, eliminating mutex contention.
- **Memory Consumption:** Per-client state consumes $\approx 128$ bytes in memory. A 100,000 active client dictionary occupies only $\approx 12.8\text{MB}$ of RAM.
- **Garbage Collection:** An automated TTL pruner evicts inactive clients older than 5 minutes, preventing memory leak vectors.
