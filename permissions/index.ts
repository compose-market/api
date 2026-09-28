import * as store from "./storage.js";

export type ConsentType =
    | "filesystem"
    | "camera"
    | "microphone"
    | "geolocation"
    | "clipboard"
    | "notifications";

export interface UserPermission {
    userAddress: string;
    agentWallet: string;
    consentType: ConsentType;
    granted: boolean;
    grantedAt: number;
    expiresAt?: number;
}