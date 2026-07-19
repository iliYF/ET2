#!/bin/bash
# -*- coding: utf-8 -*-
# validate-distribution.sh - 构建产物验证脚本
#
# 在 build-cf-pages.js 执行后调用，检查：
#   1. 原始 _worker.js 的语法状态
#   2. 构建产物 dist/_worker.js 的语法和注入点
#   3. 原始文件与构建产物的差异
#
# 用法: bash scripts/validate-distribution.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

ORIGINAL="${ROOT}/_worker.js"
BUILT="${ROOT}/dist/_worker.js"

# ---------------------------------------------------------------------------
# 颜色输出
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }
info() { echo -e "${BLUE}[INFO]${NC} $1"; }

# ---------------------------------------------------------------------------
# 检查函数
# ---------------------------------------------------------------------------

check_file_exists() {
    local file="$1"
    local label="$2"
    if [ ! -f "$file" ]; then
        err "${label}: 文件不存在 → ${file}"
        return 1
    fi
    local size
    size=$(wc -c < "$file")
    info "${label}: ${file} (${size} bytes)"
}

check_syntax() {
    local file="$1"
    local label="$2"
    local strict="${3:-true}"

    info "${label}: 语法检查 (ESM mode)..."
    # Cloudflare Workers 使用 ESM 语法，用 --input-type=module 解析
    if node --input-type=module --check < "$file" 2>&1; then
        ok "${label}: 语法检查通过"
        return 0
    fi

    if [ "$strict" = true ]; then
        err "${label}: 语法检查失败！"
        node --input-type=module --check < "$file" 2>&1 || true
        return 1
    else
        warn "${label}: 语法检查有警告（可能含 Cloudflare Workers 特有语法）"
        node --input-type=module --check < "$file" 2>&1 || true
        return 0
    fi
}

check_injection_points() {
    local file="$1"
    local label="$2"
    local expect="${3:-found}"

    local missing=0

    if grep -q "伪装页URL !== 'custom'" "$file"; then
        if [ "$expect" = "found" ]; then
            ok "${label}: URL exclusion 注入点已找到"
        else
            err "${label}: URL exclusion 注入点不应存在！"
            missing=$((missing + 1))
        fi
    else
        if [ "$expect" = "not_found" ]; then
            ok "${label}: URL exclusion 注入点不存在（符合预期）"
        else
            err "${label}: URL exclusion 注入点未找到！"
            missing=$((missing + 1))
        fi
    fi

    if grep -q "htmlCustom" "$file"; then
        if [ "$expect" = "found" ]; then
            ok "${label}: htmlCustom 注入点已找到"
        else
            err "${label}: htmlCustom 注入点不应存在！"
            missing=$((missing + 1))
        fi
    else
        if [ "$expect" = "not_found" ]; then
            ok "${label}: htmlCustom 注入点不存在（符合预期）"
        else
            err "${label}: htmlCustom 注入点未找到！"
            missing=$((missing + 1))
        fi
    fi

    return "$missing"
}

show_diff_summary() {
    local src="$1"
    local dst="$2"

    info "原始 vs 构建产物差异..."
    echo ""

    local added
    added=$(diff "$src" "$dst" | grep -c '^>' || true)
    local removed
    removed=$(diff "$src" "$dst" | grep -c '^<' || true)

    info "新增行: ${added}, 删除行: ${removed}"

    echo ""
    echo "--- 差异详情（前 200 行）---"
    diff -u --label="原始 _worker.js" "$src" --label="构建后 _worker.js" "$dst" | head -n 200
    echo "--- 差异详情结束 ---"
    echo ""
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

echo ""
echo "=========================================="
echo "  EdgeTunnel 构建产物验证"
echo "=========================================="
echo ""

FAILED=0

# ---- 1. 检查原始文件 ----
echo "--- 1. 原始文件检查 ---"
echo ""

check_file_exists "$ORIGINAL" "原始文件" || FAILED=1

if [ "$FAILED" -eq 0 ]; then
    # 原始文件语法检查宽松处理，因为可能含 Workers 特有语法
    check_syntax "$ORIGINAL" "原始文件" false || true
    # 原始文件不应该有注入点
    check_injection_points "$ORIGINAL" "原始文件" "not_found" || true
fi

echo ""

# ---- 2. 检查构建产物 ----
echo "--- 2. 构建产物检查 ---"
echo ""

check_file_exists "$BUILT" "构建产物" || FAILED=1

if [ "$FAILED" -eq 0 ]; then
    # 构建产物语法检查严格处理
    if ! check_syntax "$BUILT" "构建产物" true; then
        FAILED=1
    fi

    # 构建产物必须有注入点
    if ! check_injection_points "$BUILT" "构建产物" "found"; then
        FAILED=1
    fi
fi

echo ""

# ---- 3. 差异对比 ----
if [ "$FAILED" -eq 0 ] && [ -f "$ORIGINAL" ]; then
    echo "--- 3. 差异对比 ---"
    echo ""
    show_diff_summary "$ORIGINAL" "$BUILT"
fi

echo ""

# ---- 5. 结果 ----
echo ""
echo "=========================================="
if [ "$FAILED" -eq 0 ]; then
    ok "所有验证通过"
    echo "=========================================="
    echo ""
    exit 0
else
    err "验证失败，请检查上述错误"
    echo "=========================================="
    echo ""
    exit 1
fi
