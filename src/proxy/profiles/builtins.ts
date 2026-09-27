/**
 * 内置 profile 注册入口：src/proxy 的消费方（config/tool）import 本模块一次，
 * 所有随构建发布的 profile 即就位。新增 profile 在这里追加。
 */
import { registerBrowserProfile } from './browser.js';
import { registerTestProfile } from './test.js';

registerTestProfile();
registerBrowserProfile();
