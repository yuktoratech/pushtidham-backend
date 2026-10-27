import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config/env.js';
const config=loadConfig({NODE_ENV:'test',PORT:'4000',MONGODB_URI:'mongodb://127.0.0.1/auth_checkout_test',JWT_ACCESS_SECRET:randomBytes(40).toString('hex'),JWT_REFRESH_SECRET:randomBytes(40).toString('hex'),JWT_ACCESS_EXPIRES_IN:'15m',JWT_REFRESH_EXPIRES_IN:'7d',FRONTEND_URL:'http://localhost:3000',STRIPE_CARD_ENABLED:'false'});
test('anonymous checkout requires login before validation, database writes or provider access',async()=>{
 const result=await request(createApp(config)).post('/api/v1/payments/stripe/checkout-sessions').send({donorEmail:'existing@example.test'});
 assert.equal(result.status,401);
 assert.equal(result.body.error.code,'UNAUTHENTICATED');
});
