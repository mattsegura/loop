#!/bin/sh
# Runs one test file with a hard time limit (kills the whole process group, so nothing is left
# running) and prints a one-line summary. Used by release.sh.
out=$(perl -e '
  my $t = shift; my $pid = fork();
  if (!$pid) { setpgrp(0, 0); exec @ARGV; exit 127 }
  $SIG{ALRM} = sub { kill "KILL", -$pid; exit 142 };
  alarm $t; waitpid($pid, 0); exit($? >> 8);
' 300 node --test --test-concurrency=1 --test-force-exit --test-reporter=tap "$1" 2>&1)
rc=$?
p=$(printf '%s\n' "$out" | sed -n 's/^# pass //p' | tail -1)
f=$(printf '%s\n' "$out" | sed -n 's/^# fail //p' | tail -1)
echo "rc=$rc pass=${p:-?} fail=${f:-?} $1"
