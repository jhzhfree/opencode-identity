import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPublicKey,createHash,verify} from 'node:crypto';
import {keyId} from '../src/keys.mjs';
test('public expired AKB vector preserves signature, UTF-8 request and profile boundaries',async()=>{
 const v=JSON.parse(await readFile(new URL('../../../contracts/akb-v2/vector.json',import.meta.url)));
 const [h,c,s]=v.proof.split('.'); const header=JSON.parse(Buffer.from(h,'base64url')); const claims=JSON.parse(Buffer.from(c,'base64url'));
 assert.equal(header.typ,'akb-agent-proof+jwt'); assert.equal(header.kid,keyId(v.publicJwk)); assert.equal(claims.ver,2);
 const key=createPublicKey({key:v.publicJwk,format:'jwk'});
 assert.ok(verify('RSA-SHA256',Buffer.from(h+'.'+c),key,Buffer.from(s,'base64url')));
 assert.equal(createHash('sha256').update(v.body).digest('hex'),v.bodySha256);
 assert.equal(claims.request_binding.body_sha256,v.bodySha256); assert.equal(claims.request_binding.target,v.target);
 assert.equal(claims.credential_sha256,createHash('sha256').update(v.serviceKey).digest('hex'));
 assert.ok(!verify('RSA-SHA256',Buffer.from(h+'.'+Buffer.from(JSON.stringify({...claims,sub:'agent:forged'})).toString('base64url')),key,Buffer.from(s,'base64url')));
});
