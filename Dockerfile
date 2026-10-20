# XScript 管理后台镜像。在仓库根目录构建：
#
#   docker build -t xscript-server .                    # slim：云控 / 卡密 / 小程序 / 热更新（约 250 MB）
#   docker build -t xscript-server:full --target full . # full：额外带 JDK + Android SDK，可在后台打包 APK（约 2.5 GB）
#
# 部署见 deploy/docker-compose.yml 和 docs/部署.md。

# ---------------------------------------------------------------- 前端
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY backend/web/package.json backend/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/web/ ./
RUN npm run build

# ---------------------------------------------------------------- slim
FROM python:3.12-slim-bookworm AS slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    XSCRIPT_DATA=/data \
    XSCRIPT_PACK=off
RUN groupadd --system --gid 10001 xscript \
    && useradd --system --uid 10001 --gid xscript --home-dir /home/xscript --create-home xscript
WORKDIR /app
# Dependencies first so code edits don't reinstall them.
COPY backend/pyproject.toml backend/pyproject.toml
RUN mkdir -p backend/xscript_server && touch backend/xscript_server/__init__.py \
    && pip install -e "backend[postgres]" && rm -rf backend/xscript_server
COPY backend/xscript_server backend/xscript_server
COPY backend/xscript_pack.py backend/xscript_pack.py
COPY --from=web /web/dist backend/web/dist
COPY deploy/entrypoint.sh /usr/local/bin/xscript-entrypoint
RUN chmod 755 /usr/local/bin/xscript-entrypoint \
    && mkdir -p /data && chown xscript:xscript /data
USER xscript
VOLUME /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=4).status == 200 else 1)"
ENTRYPOINT ["xscript-entrypoint"]
CMD ["serve"]

# ---------------------------------------------------------------- full (APK 打包)
FROM slim AS full
USER root
ARG CMDLINE_TOOLS=https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
ARG UV_VERSION=0.9.5
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    XSCRIPT_PACK=on \
    GRADLE_USER_HOME=/data/.gradle \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && if [ "$(dpkg --print-architecture)" = "arm64" ]; then \
         ln -s /usr/lib/jvm/java-17-openjdk-arm64 /usr/lib/jvm/java-17-openjdk-amd64; fi
# Android SDK: same platform / build-tools as android/app/build.gradle.kts.
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl -fsSL "$CMDLINE_TOOLS" -o /tmp/tools.zip \
    && unzip -q /tmp/tools.zip -d /tmp/tools && mv /tmp/tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
    && rm -rf /tmp/tools /tmp/tools.zip \
    && yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null \
    && "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platforms;android-37.0" "build-tools;36.0.0" "platform-tools" >/dev/null
# Chaquopy and 代码保护 need a Python 3.10 matching the app's interpreter.
RUN pip install "uv==$UV_VERSION" && uv python install 3.10 \
    && ln -s "$(uv python find 3.10)" /usr/local/bin/python3.10
ENV XSCRIPT_BUILD_PYTHON=/usr/local/bin/python3.10
COPY android /app/android
RUN rm -rf /app/android/build /app/android/app/build /app/android/.gradle /app/android/local.properties \
    && chown -R xscript:xscript /app/android
USER xscript
