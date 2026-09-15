FROM --platform=linux/amd64 node:22-bookworm-slim AS node-runtime

FROM --platform=linux/amd64 eclipse-temurin:17-jdk-jammy AS cache
ARG ANDROID_COMMAND_LINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
ARG GRADLE_DISTRIBUTION_URL=https://services.gradle.org/distributions/gradle-8.11.1-bin.zip
ENV ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_HOME=/opt/android-sdk GRADLE_USER_HOME=/opt/gradle-home
ENV PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/35.0.0:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/android-sdk/cmdline-tools /opt/gradle-home
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN curl -fL "$ANDROID_COMMAND_LINE_TOOLS_URL" -o /tmp/cmdline-tools.zip \
 && unzip -q /tmp/cmdline-tools.zip -d /tmp/android-tools \
 && mv /tmp/android-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
 && yes | sdkmanager --licenses >/dev/null \
 && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
 && curl -fL "$GRADLE_DISTRIBUTION_URL" -o /opt/gradle-8.11.1-bin.zip
COPY android-project /opt/template
RUN sed -i 's#^distributionUrl=.*#distributionUrl=file\:/opt/gradle-8.11.1-bin.zip#' /opt/template/gradle/wrapper/gradle-wrapper.properties \
 && chmod +x /opt/template/gradlew \
 && cp -a /opt/template /tmp/prewarm-project \
 && cd /tmp/prewarm-project \
 && ./gradlew --no-daemon --refresh-dependencies clean :simpleDemo:assembleRelease \
 && test -n "$(find simpleDemo/build/outputs/apk/release -maxdepth 1 -name '*.apk' -type f -print -quit)" \
 && apksigner verify simpleDemo/build/outputs/apk/release/*.apk \
 && rm -rf /tmp/prewarm-project /opt/template/.gradle /opt/template/simpleDemo/build \
 && find /opt/template -name '.DS_Store' -delete
COPY docker /opt/scripts

FROM --platform=linux/amd64 eclipse-temurin:17-jdk-jammy
ENV ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_HOME=/opt/android-sdk GRADLE_USER_HOME=/opt/gradle-home
ENV PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/35.0.0:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends coreutils unzip && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin builder \
 && mkdir -p /work /input /output /opt/scripts \
 && chown builder:builder /work /output
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=cache /opt/android-sdk /opt/android-sdk
COPY --from=cache /opt/gradle-home /opt/gradle-home
COPY --from=cache /opt/gradle-8.11.1-bin.zip /opt/gradle-8.11.1-bin.zip
COPY --from=cache /opt/template /opt/template
COPY --from=cache /opt/scripts /opt/scripts
RUN chmod 0555 /opt/scripts/entrypoint.sh /opt/scripts/prepare-project.js \
 && chmod -R a-w /opt/template /opt/android-sdk /opt/gradle-home /opt/gradle-8.11.1-bin.zip \
 && chmod -R a+rX /opt/template /opt/android-sdk /opt/gradle-home \
 && chmod a+r /opt/gradle-8.11.1-bin.zip
USER builder
WORKDIR /work
ENTRYPOINT ["/opt/scripts/entrypoint.sh"]