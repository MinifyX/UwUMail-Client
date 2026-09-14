#!/usr/bin/env bash
# Starts a Stalwart mail server for the JMAP integration test, with the domain
# uwumail.test and two users:
#
#   mini@uwumail.test  Kirschbluete-Tastatur-42!
#   leni@uwumail.test  Seifenblase-Wanderweg-17!
#
#   dev/stalwart.sh
#   UWUMAIL_TEST_JMAP=http://127.0.0.1:8080 cargo test -p uwumail-core --test stalwart
#
# Stalwart announces https://mail.uwumail.test as its public address; the
# client falls back to the address it was given when that isn't reachable.
set -euo pipefail

NAME=${STALWART_CONTAINER:-uwumail-stalwart}
PORT=${STALWART_PORT:-8080}
IMAGE=${STALWART_IMAGE:-stalwartlabs/stalwart:v0.16}
BOOTSTRAP_ADMIN="admin:uwumail-test"
BASE="http://127.0.0.1:$PORT"

call() {
  curl -fsS -u "$1" -H 'Content-Type: application/json' --data "$2" "$BASE/jmap/"
}

wait_for_login() {
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null -u "$1" "$BASE/jmap/session" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "Stalwart didn't come up on $BASE" >&2
  docker logs "$NAME" >&2 || true
  exit 1
}

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e "STALWART_RECOVERY_ADMIN=$BOOTSTRAP_ADMIN" -p "$PORT:8080" "$IMAGE" >/dev/null
wait_for_login "$BOOTSTRAP_ADMIN"

# Finish the setup wizard: this creates the permanent administrator.
answer=$(call "$BOOTSTRAP_ADMIN" '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Bootstrap/set",{"accountId":"d333333","update":{"singleton":{"serverHostname":"mail.uwumail.test","defaultDomain":"uwumail.test","requestTlsCertificate":false,"generateDkimKeys":false}}},"0"]]}')
secret=$(printf '%s' "$answer" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p')
if [ -z "$secret" ]; then
  echo "Stalwart setup failed: $answer" >&2
  exit 1
fi
docker restart "$NAME" >/dev/null
ADMIN="admin@uwumail.test:$secret"
wait_for_login "$ADMIN"

domain=$(call "$ADMIN" '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Domain/get",{"accountId":"b","ids":null,"properties":["id","name"]},"0"]]}' |
  sed -n 's/.*"name":"uwumail.test","id":"\([^"]*\)".*/\1/p')
domain=${domain:-b}

users=$(call "$ADMIN" "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Account/set\",{\"accountId\":\"b\",\"create\":{
  \"mini\":{\"@type\":\"User\",\"name\":\"mini\",\"domainId\":\"$domain\",\"description\":\"Mini\",\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\"Kirschbluete-Tastatur-42!\"}},\"roles\":{\"@type\":\"User\"}},
  \"leni\":{\"@type\":\"User\",\"name\":\"leni\",\"domainId\":\"$domain\",\"description\":\"Leni Wanders\",\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\"Seifenblase-Wanderweg-17!\"}},\"roles\":{\"@type\":\"User\"}}
}},\"0\"]]}")
case "$users" in
  *'"notCreated"'*)
    echo "Creating the test users failed: $users" >&2
    exit 1
    ;;
esac
wait_for_login "mini@uwumail.test:Kirschbluete-Tastatur-42!"
echo "Stalwart is ready on $BASE"
