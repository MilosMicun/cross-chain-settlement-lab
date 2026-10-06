# Run through bash scripts/record-demo.sh; outputs stay in its ignored session.
Output raw.gif
Output terminal.txt
Require bash
Set Shell bash
Set FontFamily "DejaVu Sans Mono"
Set FontSize 20
Set Columns 104
Set Rows 34
Set Padding 20
Set Framerate 10
Set CursorBlink false
Set TypingSpeed 35ms
# Keep the CLI's cyan heading, yellow selection and green verified outcomes.
Set Theme {"background":"#101820","foreground":"#e6edf3","black":"#101820","red":"#ff6b6b","green":"#70db96","yellow":"#f4cf65","blue":"#79b8ff","magenta":"#d2a8ff","cyan":"#68d5e5","white":"#e6edf3","brightBlack":"#101820","brightRed":"#ff6b6b","brightGreen":"#70db96","brightYellow":"#f4cf65","brightBlue":"#79b8ff","brightMagenta":"#d2a8ff","brightCyan":"#68d5e5","brightWhite":"#ffffff","cursor":"#e6edf3"}

Hide
Type `source "$RECORD_DEMO_SESSION/terminal-init.sh"`
Enter
Wait+Line@10s /^\$$/
Show
Type "bash scripts/run-demo-ui.sh"
Enter
Wait+Screen@10s /LOCAL RUN \/ SELECT SCENARIO/
Sleep 1s
Down
Sleep 600ms
Down
Sleep 1200ms
Screenshot menu.png
Sleep 300ms
Enter
Wait+Screen@15s /Running: check-/
Sleep 1500ms
Screenshot filled-running.png
Sleep 300ms
Hide
# Builds (1800s) and the first runner (2000s) have existing bounded deadlines.
Wait+Screen@4000s /VERIFIED \/ Filled.*result 1\/1/
Wait+Screen@10s /Enter: run Cancelled local demo/
Show
Sleep 7s
Screenshot filled.png
Sleep 300ms
Type "e"
Wait+Screen@10s /PUBLIC EVIDENCE \/ Filled/
Sleep 3s
Screenshot evidence.png
Sleep 300ms
Type "e"
Wait+Screen@10s /VERIFIED \/ Filled/
Sleep 1s
Enter
Wait+Screen@15s /Running: check-cancelled-recovery.sh/
Sleep 1500ms
Screenshot cancelled-running.png
Sleep 300ms
Hide
Wait+Screen@2100s /VERIFIED \/ Cancelled.*result 2\/2/
Wait+Screen@10s /Enter: finish demo/
Show
Sleep 7s
Screenshot cancelled.png
Sleep 300ms
Left
Wait+Screen@10s /VERIFIED \/ Filled.*result 1\/2/
Sleep 2500ms
Screenshot previous-result.png
Sleep 300ms
Right
Wait+Screen@10s /VERIFIED \/ Cancelled.*result 2\/2/
Sleep 2s
Screenshot next-result.png
Sleep 300ms
Enter
Wait+Screen@10s /Verified 2 scenario\(s\). Public summary:/
Sleep 3s
Screenshot completed.png
Sleep 300ms
