# segment-server:opentu 智能抠图推理服务(SAM 2.1 hiera-large,GPU fp32)
#
# 基底复用宿主机上现成的 davidamacey/opentranscribe-backend:v0.5.0
# (torch 2.11.0+cu128,RTX 5080/Blackwell sm_120 必须 cu128 轮子;
# 自拉 pytorch/pytorch 官方镜像在该网络环境下会卡死,见 M0 记录)。
# torchvision 必须从 download.pytorch.org/whl/cu128 安装——PyPI 轮子与
# +cu128 定制 torch ABI 不匹配(operator torchvision::nms does not exist)。
# sam2 以 vendor 源码安装;--no-build-isolation 必须,否则构建环境会从
# pypi.org 直连拉 torch 构建依赖并挂死。

FROM davidamacey/opentranscribe-backend:v0.5.0

ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_DEFAULT_TIMEOUT=60 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps --no-build-isolation \
       --index-url https://download.pytorch.org/whl/cu128 torchvision==0.26.0

# 直接从 vendor 源码 import(pip -e 会落到构建期 user-site,运行期不可见)
COPY vendor /app/vendor
ENV PYTHONPATH=/app/vendor/sam2

COPY app /app/app

ENV SEG_CKPT=/models/sam2.1_hiera_large.pt \
    SEG_DEVICE=auto \
    SEG_MEM_FRACTION=0.25 \
    SEG_MAX_SESSIONS=32 \
    SEG_SESSION_TTL_S=600

EXPOSE 8300
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8300"]
