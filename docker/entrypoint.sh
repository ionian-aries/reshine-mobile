#!/bin/sh
set -eu

INPUT_DIR=/input
OUTPUT_DIR=/output
TEMPLATE_DIR=/opt/template
PROJECT_DIR=/work/project
GRADLE_USER_HOME=/work/gradle-home
export GRADLE_USER_HOME ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_HOME=/opt/android-sdk GRADLE_OPTS=-Dorg.gradle.caching=true

BUILD_STARTED=$(date +%s)
ACTIVE_STAGE=
STAGE_STARTED=
format_seconds() { printf '%ss' "$1"; }
stage_start() { ACTIVE_STAGE=$1; STAGE_STARTED=$(date +%s); printf '[build:apk/container] 阶段开始：%s\n' "$ACTIVE_STAGE"; }
stage_end() { now=$(date +%s); printf '[build:apk/container] 阶段完成：%s（%s）\n' "$ACTIVE_STAGE" "$(format_seconds $((now - STAGE_STARTED)))"; ACTIVE_STAGE=; STAGE_STARTED=; }
fail() { printf 'Android APK 构建失败：%s\n' "$1" >&2; exit 1; }
cleanup() {
  status=$?
  now=$(date +%s)
  if [ -n "$ACTIVE_STAGE" ]; then printf '[build:apk/container] 阶段失败：%s（%s）\n' "$ACTIVE_STAGE" "$(format_seconds $((now - STAGE_STARTED)))" >&2; fi
  printf '[build:apk/container] 总耗时：%s（%s）\n' "$(format_seconds $((now - BUILD_STARTED)))" "$([ "$status" -eq 0 ] && printf 成功 || printf 失败)"
  rm -rf "$PROJECT_DIR" "$GRADLE_USER_HOME"
}
trap cleanup EXIT HUP INT TERM

[ -f "$INPUT_DIR/config.json" ] || fail '缺少 /input/config.json'
[ -d "$OUTPUT_DIR" ] || fail '缺少输出目录 /output'
[ -d "$TEMPLATE_DIR" ] || fail '镜像内缺少 Android 模板'
probe="$OUTPUT_DIR/.write-probe-$$"
touch "$probe" 2>/dev/null || fail '/output 不可写'
rm -f "$probe"

rm -rf "$PROJECT_DIR" "$GRADLE_USER_HOME"
stage_start '复制预热 Gradle Home'
cp -a /opt/gradle-home "$GRADLE_USER_HOME"
chmod -R u+rwX "$GRADLE_USER_HOME"
stage_end
stage_start '准备 Android 工程'
node /opt/scripts/prepare-project.js "$TEMPLATE_DIR" "$INPUT_DIR" "$PROJECT_DIR" || fail 'Android 工程准备失败'
stage_end

cd "$PROJECT_DIR"
stage_start 'Gradle 离线 assembleRelease'
./gradlew --offline --no-daemon --build-cache --stacktrace :simpleDemo:assembleRelease || fail 'Gradle 离线构建失败'
stage_end
stage_start '校验签名与输出 APK'
set -- simpleDemo/build/outputs/apk/release/*.apk
[ "$#" -eq 1 ] && [ -f "$1" ] || fail 'release APK 数量不是 1'
source_apk="$1"
apksigner verify --verbose "$source_apk" >/dev/null || fail 'APK 签名验证失败'
[ -n "${ANDROID_BUILDER_IMAGE:-}" ] || fail '缺少构建镜像标识'
expected_image=$(node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(String(c.template?.image||''))" "$INPUT_DIR/config.json") || fail '构建镜像标识读取失败'
[ "$expected_image" = "$ANDROID_BUILDER_IMAGE" ] || fail '运行时 config 中的镜像标识与实际镜像不一致'
artifact_name=$(node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[1]));const safe=v=>String(v).normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'');const name=safe(c.uniapp.name),version=safe(c.uniapp.versionName);if(!name||!version)process.exit(1);process.stdout.write(name+'-v'+version+'.apk')" "$INPUT_DIR/config.json") || fail 'APK 文件名生成失败'
find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp "$source_apk" "$OUTPUT_DIR/$artifact_name"
[ -s "$OUTPUT_DIR/$artifact_name" ] || fail 'APK 输出失败'
stage_end
printf 'Android APK 构建成功\n%s\n' "$OUTPUT_DIR/$artifact_name"