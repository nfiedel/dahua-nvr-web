#!/usr/bin/env bash
# Manual start/stop without systemd:  ./nvrctl.sh start|stop|restart|status|log
set -u
cd "$(dirname "$0")"
PIDF=data/server.pid
mkdir -p data
NODE="${NODE:-$(command -v node)}"
[ -n "$NODE" ] || { echo "node not found; set NODE=/path/to/node"; exit 1; }
running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
case "${1:-status}" in
  start)
    if running; then echo "already running (pid $(cat $PIDF))"; exit 0; fi
    setsid nohup "$NODE" server.js >> data/server.log 2>&1 < /dev/null &
    echo $! > "$PIDF"; sleep 1; running && echo "started (pid $(cat $PIDF))" || { echo "failed; see data/server.log"; exit 1; } ;;
  stop)
    if running; then kill "$(cat $PIDF)"; for _ in 1 2 3 4 5 6 7 8 9 10; do running || break; sleep 0.3; done; fi
    rm -f "$PIDF"; echo "stopped" ;;
  restart) "$0" stop; "$0" start ;;
  status) running && echo "running (pid $(cat $PIDF))" || echo "not running" ;;
  log) tail -n 50 -f data/server.log ;;
  *) echo "usage: $0 start|stop|restart|status|log"; exit 2 ;;
esac
