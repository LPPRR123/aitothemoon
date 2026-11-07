#!/bin/bash
# Run the vanilla client headless on Xvfb display :99 and quick-play a world in $MC_HOME/client/game/saves.
# usage: runclient.sh WORLD_FOLDER_NAME      (needs: python3 getclient.py <version.json> $MC_HOME/client first)
MC_HOME=${MC_HOME:-$PWD/mc-verify-work}
C=$MC_HOME/client
JAVA=${MC_JAVA:-$MC_HOME/jre/bin/java}
VER=${MC_VERSION:-26.3}
INDEX=$(basename $(ls $C/assets/indexes/*.json | head -1) .json)
cd $C/game || exit 1
unset JAVA_TOOL_OPTIONS
export DISPLAY=${DISPLAY:-:99}
exec $JAVA -Xmx5G -XX:+UseG1GC -cp "$(cat $C/classpath.txt)" net.minecraft.client.main.Main \
  --username Player --version $VER --gameDir $C/game --assetsDir $C/assets --assetIndex $INDEX \
  --uuid 00000000000040008000000000000001 --accessToken 0 --userType msa --versionType release \
  --width 1280 --height 720 --quickPlaySingleplayer "$1"
