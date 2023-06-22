import { DEFAULT_CONNECTION_CONFIG } from "../Defaults";
import { UserFacingSocketConfig } from "../Types";
import { makeRegistrationSocket as _makeSocket } from "./registration";

function makeWASocket(config: UserFacingSocketConfig) {
  return _makeSocket({
    ...DEFAULT_CONNECTION_CONFIG,
    ...config,
  });
}

export default makeWASocket;
