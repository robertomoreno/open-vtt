# Chrome host → Safari player: connection investigation

## Report
- Same computer; manual invitation/reply exchange; Connect player clicked in the original host tab.
- Host and player both show “Connection closed or invitation expired”; player also shows “Host connection lost”.
- Exact versions and elapsed time are not yet known. Do not publish signaling links or SDP.

## Evidence and hypotheses
- 2026-10-31: unchanged Chromium→WebKit public-UI real-channel scenario passed (1 test, 10.2 seconds). This is not shipping-Safari evidence.
- The app receives a specific transport error, then replaces it with the generic closed/expired message. This hides the failing stage.
- The guest closes its reply after 45 seconds even if the host has not yet applied it. The host invitation remains valid for 10 minutes. A delayed manual exchange can therefore fail before the host uses a valid reply.
- Safari-specific ICE/network failure remains possible; the reported messages do not establish it.

## Work
- [x] Trace status rendering and exchange timers.
- [x] Observe failing regressions for lost errors and premature guest timeout (5 failed before the fix, then passed).
- [x] Preserve failure reason and include non-sensitive ICE/peer/channel states.
- [x] Give pending guest replies the manual-exchange window; retain the host’s 45-second post-accept deadline.
- [x] Run unit/build and targeted real-browser verification: 76/76 unit tests; typecheck/build passed; 3/3 native-channel Chromium↔WebKit tests passed, including a simulated 60-second manual-reply delay.
- [ ] Obtain user retest in shipping Chrome/Safari; do not claim the reported failure resolved without evidence.

## Decision and limits
The guest cannot know when the host applies a manually returned answer. Its app-level deadline therefore uses the manual-exchange window, while the host retains the short post-accept deadline. Browser-level ICE failures can still close a pending guest sooner; this change is not a NAT/relay workaround or a guarantee of connectivity. Failure diagnostics contain only state labels, never SDP, network addresses, or credentials.

## Review and remaining evidence
- Focused independent review: no Critical or Important findings. Corrected a privacy-test fixture so sensitive local and remote descriptions are actually present during the timeout.
- The full browser matrix was not rerun in this investigation; the five previously failing scenarios remain unproven. WebKit automation does not establish shipping Safari behavior.
- User must refresh both browsers, restore/open the host game, and exchange fresh links. If it still fails, the preserved failure text and ICE/peer/channel states should identify the failing stage. The reported Chrome/Safari failure is not yet established resolved.
