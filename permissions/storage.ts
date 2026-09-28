import { Redis as ValkeyClient } from "ioredis";

type ValkeyClientType = ValkeyClient;
const VALKEY_COMMAND_TIMEOUT_MS = 500;
const VALKEY_KEEP_ALIVE_MS = 10_000;