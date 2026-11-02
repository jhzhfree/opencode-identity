# AKB Agent V2 contract (version 1)

Production profile: `AGENT_KEY_RS256_V2`; header `X-AKB-Workload-Assertion`; JWT typ `akb-agent-proof+jwt`, alg `RS256`, ver 2. Local `X-Agent-Proof` V1 remains a different profile; no automatic fallback.

Transport carries the service credential in `X-API-Key`. Proof binds its UTF-8 SHA-256, exact method, public path + query, and SHA-256 of the exact transmitted body bytes. Serialize once, sign and transmit those same bytes. RSA 3072–4096, exponent 65537; kid is base64url SHA-256 of JSON `{e,kty,n}` in that order. TTL is positive and <=60 seconds; use fresh UUID jti per HTTP request. UUID-based invocation_id correlates one operation; session_id is a host session, not a trace ID.

Required claims: iss, aud, resource, policy_id, azp, sub (`agent:<uuid>`), platform_id, installation_id, workspace_id, runtime_agent, session_id, invocation_id, iat, exp, jti, credential_sha256, request_binding {method,target,body_sha256}. Optional message_id and terminal_agent are signed host diagnostics; registered identity and policy determine authority.

Authorization is independent of signature verification. Preserve SERVICE_SCOPE / AGENT_INTERSECTION and resource ACLs. Service credentials are service actors, never invented Agent identities. Discovery is not business access. Knowledge tools use only `knowledgeBaseId` with a generated KB_ identifier; search uses query, query uses question. Agent identity fields never come from tool arguments.

`vector.json` is an EXPIRED PUBLIC signature vector, including a synthetic non-credential service key; no private key is retained. It is checked by Node, Java and Python. Signature-only fixture checks intentionally disable time checks; production verifiers MUST check time, policy, resource, key status, scope, and replay. Live tests generate fresh signed requests and check those rejection paths separately.

When updating the vector, copy the identical JSON to AKB backend/src/test/resources/akb-v2-vector.json and Octop tests/fixtures/identity/akb-v2-vector.json. Never generate fixture data from production keys.
