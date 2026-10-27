// Public STUN discovers network addresses; it never relays gameplay. No TURN.
export const rtcConfiguration: RTCConfiguration = {iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}]};
