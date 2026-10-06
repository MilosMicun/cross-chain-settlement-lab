# Run through bash scripts/record-demo.sh; outputs stay in its ignored session.
Output raw.gif
Output terminal.txt
Require bash
Set Shell bash
Set FontFamily "DejaVu Sans Mono"
Set FontSize 20
Set Columns 78
Set Rows 24
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
Sleep 2s
Down
Sleep 400ms
Up
Sleep 800ms
Screenshot menu.png
Sleep 300ms
Enter
Wait+Screen@15s /Running: check-/
Sleep 1500ms
Screenshot filled-running.png
Sleep 300ms
Hide
# Builds (1800s) and the runner (2000s) retain their bounded deadlines.
Wait+Screen@4000s /VERIFIED WALKTHROUGH \/ Filled.*Step 1 \/ 6/
Wait+Screen@10s /Enter: next step/
Show
# These are verified reviews of the completed run, not live transaction stages.
Sleep 3500ms
Screenshot story-01.png
Sleep 300ms
Enter
Wait+Screen@10s /Step 2 \/ 6/
Sleep 3500ms
Screenshot story-02.png
Sleep 300ms
Right
Wait+Screen@10s /Step 3 \/ 6/
Sleep 3500ms
Screenshot story-03.png
Sleep 300ms
Enter
Wait+Screen@10s /Step 4 \/ 6/
Sleep 5s
Screenshot story-04.png
Sleep 300ms
Type "e"
Wait+Screen@10s /PUBLIC EVIDENCE \/ Filled/
Sleep 2s
Screenshot evidence-identifiers.png
Sleep 300ms
Down 8
Wait+Screen@10s /Walkthrough details:/
Sleep 2s
Screenshot evidence.png
Sleep 300ms
Type "e"
Wait+Screen@10s /Step 4 \/ 6/
Enter
Wait+Screen@10s /Step 5 \/ 6/
Sleep 3500ms
Screenshot story-05.png
Sleep 300ms
Enter
Wait+Screen@10s /Step 6 \/ 6/
Sleep 4s
Screenshot story-06.png
Sleep 300ms
Enter
Wait+Screen@10s /VERIFIED \/ Filled.*result 1\/1/
Wait+Screen@10s /Enter: finish demo/
Sleep 2s
Screenshot filled-top.png
Sleep 300ms
Down 22
Wait+Screen@10s /Cleanup: owned processes stopped=True; ports released=True/
Sleep 4s
Screenshot filled.png
Sleep 300ms
Enter
Wait+Screen@10s /Verified 1 scenario\(s\). Public summary:/
Sleep 2500ms
Screenshot completed.png
Sleep 300ms
