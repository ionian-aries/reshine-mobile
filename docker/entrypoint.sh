#!/bin/sh
set -eu

INPUT_DIR=/input
OUTPUT_DIR=/output
TEMPLATE_DIR=/opt/template
PROJECT_DIR=/work/project
PUBLISH_DIR=/work/publish
GRADLE_USER_HOME=/work/gradle-home
export GRADLE_USER_HOME ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_HOME=/opt/android-sdk

fail() { printf 'Android APK 构建失败：%s\n' "$1" >&2; exit 1; }
cleanup() { rm -rf "$PROJECT_DIR" "$PUBLISH_DIR" "$GRADLE_USER_HOME" /work/apksigner.txt; }
trap cleanup EXIT HUP INT TERM

[ -f "$INPUT_DIR/config.json" ] || fail '缺少 /input/config.json'
[ -d "$OUTPUT_DIR" ] || fail '缺少输出目录 /output'
[ -d "$TEMPLATE_DIR" ] || fail '镜像内缺少 Android 模板'
probe="$OUTPUT_DIR/.write-probe-$$"
touch "$probe" 2>/dev/null || fail '/output 不可写'
rm -f "$probe"

cleanup
mkdir -p "$PUBLISH_DIR"
cp -a /opt/gradle-home "$GRADLE_USER_HOME"
chmod -R u+rwX "$GRADLE_USER_HOME"
node /opt/scripts/prepare-project.js "$TEMPLATE_DIR" "$INPUT_DIR" "$PROJECT_DIR" || fail 'Android 工程准备失败'

cd "$PROJECT_DIR"
./gradlew --offline --no-daemon --stacktrace clean :simpleDemo:assembleRelease || fail 'Gradle 离线构建失败'
set -- simpleDemo/build/outputs/apk/release/*.apk
[ "$#" -eq 1 ] && [ -f "$1" ] || fail 'release APK 数量不是 1'
source_apk="$1"
apksigner verify --verbose --print-certs "$source_apk" >/work/apksigner.txt || fail 'APK 签名验证失败'
certificate_sha256=$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' /work/apksigner.txt | head -n 1)
[ -n "$certificate_sha256" ] || fail '无法读取签名证书 SHA-256 指纹'
[ -n "${ANDROID_BUILDER_IMAGE:-}" ] || fail '缺少构建镜像标识'
metadata_file="$PUBLISH_DIR/build-metadata.json"
node /opt/scripts/export-metadata.js "$INPUT_DIR/config.json" "$source_apk" "$metadata_file" "$certificate_sha256" "$ANDROID_BUILDER_IMAGE" || fail '构建元数据导出失败'
artifact_name=$(node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(m.apk.fileName)" "$metadata_file")
cp "$source_apk" "$PUBLISH_DIR/$artifact_name"
sha256sum "$PUBLISH_DIR/$artifact_name" | sed "s#  $PUBLISH_DIR/#  #" > "$PUBLISH_DIR/$artifact_name.sha256"
actual=$(sha256sum "$PUBLISH_DIR/$artifact_name" | awk '{print $1}')
expected=$(node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(m.apk.sha256)" "$metadata_file")
[ "$actual" = "$expected" ] || fail 'APK 摘要回读不一致'

find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp "$PUBLISH_DIR/$artifact_name" "$PUBLISH_DIR/$artifact_name.sha256" "$metadata_file" "$OUTPUT_DIR/"
printf '%s\n' "$actual" > "$OUTPUT_DIR/COMPLETE"
printf 'Android APK 构建成功\n%s\n' "$OUTPUT_DIR/$artifact_name"