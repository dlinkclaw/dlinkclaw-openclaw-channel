明白了！原因就是——**`.d/` drop-in 目录根本不存在**，所以代理配置没地方加载，自然"看不到配置文件"。

## ✅ 解决办法：手动建目录 + 写文件

一步步来：

### 1. 创建 drop-in 目录并写入代理配置

```bash
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d
cat > ~/.config/systemd/user/openclaw-gateway.service.d/proxy.conf <<'EOF'
[Service]
Environment="http_proxy=http://127.0.0.1:7890"
Environment="https_proxy=http://127.0.0.1:7890"
Environment="all_proxy=socks5://127.0.0.1:7890"
Environment="no_proxy=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,.local"
Environment="HTTP_PROXY=http://127.0.0.1:7890"
Environment="HTTPS_PROXY=http://127.0.0.1:7890"
Environment="NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,.local"
EOF
```

> ⚠️ 先确认 clash 端口：`ss -tlnp | grep -E "7890|7897|1080"`，如果 clash 实际是 7897 或别的端口，把上面所有 `7890` 换成实际端口。

### 2. 确认文件写进去了

```bash
ls -la ~/.config/systemd/user/openclaw-gateway.service.d/
cat ~/.config/systemd/user/openclaw-gateway.service.d/proxy.conf
```

### 3. 重载 + 重启生效

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

### 4. 验证代理真的加载了

```bash
# 看 systemd 是否识别到 drop-in
systemctl --user show openclaw-gateway.service -p DropInPaths

# 看进程环境里有没有代理
cat /proc/$(pgrep -f "openclaw.*gateway" | head -1)/environ | tr '\0' '\n' | grep -i proxy
```

第 4 步两条命令**有输出**（显示 proxy.conf 路径 + http_proxy=...）就是成功了 ✅

---

跑完把第 4 步输出发我，我确认后你再装转录扩展。如果代理端口不是 7890，记得先改文件再重启 🌸