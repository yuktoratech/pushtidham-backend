import {before,after,beforeEach,test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import mongoose from 'mongoose';
import {MongoMemoryServer} from 'mongodb-memory-server';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config/env.js';
import {AuthService} from '../src/services/auth.js';
import {User} from '../src/models/user.js';
import {Session} from '../src/models/session.js';
const origin='https://frontend.example.test';
const config=loadConfig({NODE_ENV:'production',MONGODB_URI:'mongodb://127.0.0.1/unused',FRONTEND_URL:origin,COOKIE_SAME_SITE:'lax',JWT_ACCESS_SECRET:randomBytes(40).toString('hex'),JWT_REFRESH_SECRET:randomBytes(40).toString('hex')});
let mongo:MongoMemoryServer;
const firstCookie=(headers:Record<string,unknown>)=>{const values=headers["set-cookie"];assert.ok(Array.isArray(values));assert.equal(typeof values[0],"string");return String(values[0])};
const auth=new AuthService(config);
const credentials={email:'session-fixture@example.test',password:'Fixture-Password-123!'};
before(async()=>{mongo=await MongoMemoryServer.create();assert.match(mongo.getUri(),/^mongodb:\/\/127\.0\.0\.1:/);await mongoose.connect(mongo.getUri(),{dbName:'isolated_auth_session_tests'});await Promise.all([User.init(),Session.init()])});
after(async()=>{await mongoose.disconnect();await mongo?.stop()});
beforeEach(async()=>{await Promise.all([User.deleteMany({}),Session.deleteMany({})])});

test('production auth keeps cookie flags, exact CORS, Origin enforcement and matching logout expiry',async()=>{
 await auth.register({name:'Session Fixture',...credentials});
 const app=createApp(config);
 const login=await request(app).post('/api/v1/auth/login').set('Origin',origin).send(credentials);assert.equal(login.status,200);
 const cookie=firstCookie(login.headers);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);assert.match(cookie,/Path=\/api\/v1\/auth/);assert.doesNotMatch(cookie,/Domain=/);
 assert.equal(login.headers['access-control-allow-origin'],origin);assert.equal(login.headers['access-control-allow-credentials'],'true');assert.equal(login.body.data.refreshToken,undefined);
 const value=cookie.split(';')[0]!;
 assert.equal((await request(app).post('/api/v1/auth/refresh').set('Origin','https://untrusted.example.test').set('Cookie',value).send({})).status,403);
 const preflight=await request(app).options('/api/v1/auth/refresh').set('Origin',origin).set('Access-Control-Request-Method','POST');assert.equal(preflight.status,204);
 const refreshed=await request(app).post('/api/v1/auth/refresh').set('Origin',origin).set('Cookie',value).send({});assert.equal(refreshed.status,200);
 const logout=await request(app).post('/api/v1/auth/logout').set('Origin',origin).set('Cookie',firstCookie(refreshed.headers).split(';')[0]!).send({});assert.equal(logout.status,200);assert.match(firstCookie(logout.headers),/Path=\/api\/v1\/auth/);assert.match(firstCookie(logout.headers),/Expires=Thu, 01 Jan 1970/);
 assert.equal((await request(app).get('/api/v1/auth/me').set('Authorization','Bearer '+refreshed.body.data.accessToken)).status,401);
});

test('atomic hashed refresh rotation and replay revocation remain intact',async()=>{
 const opened=await auth.register({name:'Session Fixture',...credentials});
 const refreshed=await auth.refresh(opened.refreshToken);assert.notEqual(opened.refreshToken,refreshed.refreshToken);
 const session=await Session.findOne().select('+tokenHash');assert.match(session!.tokenHash,/^[a-f0-9]{64}$/);assert.notEqual(session!.tokenHash,refreshed.refreshToken);
 await assert.rejects(auth.refresh(opened.refreshToken));assert.ok((await Session.findOne())?.revokedAt);
 await assert.rejects(auth.authenticate(refreshed.accessToken));
});

test('refresh has a separate bounded budget and does not consume login attempts',async()=>{
 const app=createApp(config);
 for(let i=0;i<60;i++)assert.equal((await request(app).post('/api/v1/auth/refresh').set('Origin',origin).send({})).status,401);
 const limited=await request(app).post('/api/v1/auth/refresh').set('Origin',origin).send({});assert.equal(limited.status,429);
 assert.equal(limited.body.error.code,'RATE_LIMITED');
 // Invalid credentials, rather than login rate limiting: refresh uses its own budget.
 const login=await request(app).post('/api/v1/auth/login').set('Origin',origin).send(credentials);assert.equal(login.status,401);assert.equal(login.body.error.code,'INVALID_CREDENTIALS');
});

test('temporary backend refresh failure is not a 401 and does not clear cookies',async()=>{
 const app=createApp(config);
 const mocked=mock.method(AuthService.prototype,'refresh',async()=>{throw new Error('isolated temporary database failure')});
 try{
  const result=await request(app).post('/api/v1/auth/refresh').set('Origin',origin).set('Cookie','refresh_token=synthetic-fixture').send({});
  assert.equal(result.status,500);assert.equal(result.body.error.code,'INTERNAL_ERROR');assert.equal(result.headers['set-cookie'],undefined);
 }finally{mocked.mock.restore()}
});
