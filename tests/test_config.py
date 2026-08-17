"""Tests for SolverConfig validation."""

from __future__ import annotations

from pathlib import Path

import pytest

from vision_ai_recaptcha_solver.config import SolverConfig


class TestSolverConfigValidation:
    """Tests for SolverConfig input validation."""

    def test_default_config_valid(self) -> None:
        """Test that default configuration is valid."""
        config = SolverConfig()
        assert config.server_port == 8443
        assert config.timeout == 300.0
        assert config.max_attempts == 12
        assert config.log_level == "WARNING"

    def test_server_port_too_low(self) -> None:
        """Test that server_port below 1 raises error."""
        with pytest.raises(ValueError, match="server_port must be between 1 and 65535"):
            SolverConfig(server_port=0)

    def test_server_port_too_high(self) -> None:
        """Test that server_port above 65535 raises error."""
        with pytest.raises(ValueError, match="server_port must be between 1 and 65535"):
            SolverConfig(server_port=70000)

    def test_server_port_valid_range(self) -> None:
        """Test valid server port values."""
        config = SolverConfig(server_port=1)
        assert config.server_port == 1
        
        config = SolverConfig(server_port=65535)
        assert config.server_port == 65535

    def test_timeout_must_be_positive(self) -> None:
        """Test that timeout must be positive."""
        with pytest.raises(ValueError, match="timeout must be positive"):
            SolverConfig(timeout=0)
        
        with pytest.raises(ValueError, match="timeout must be positive"):
            SolverConfig(timeout=-10)

    def test_max_attempts_must_be_at_least_one(self) -> None:
        """Test that max_attempts must be at least 1."""
        with pytest.raises(ValueError, match="max_attempts must be at least 1"):
            SolverConfig(max_attempts=0)
        
        with pytest.raises(ValueError, match="max_attempts must be at least 1"):
            SolverConfig(max_attempts=-5)

    def test_max_attempts_valid(self) -> None:
        """Test valid max_attempts values."""
        config = SolverConfig(max_attempts=1)
        assert config.max_attempts == 1
        
        config = SolverConfig(max_attempts=100)
        assert config.max_attempts == 100

    def test_log_level_invalid(self) -> None:
        """Test that invalid log level raises error."""
        with pytest.raises(ValueError, match="log_level must be one of"):
            SolverConfig(log_level="INVALID")

    def test_log_level_normalized_to_uppercase(self) -> None:
        """Test that log level is normalized to uppercase."""
        config = SolverConfig(log_level="debug")
        assert config.log_level == "DEBUG"
        
        config = SolverConfig(log_level="Info")
        assert config.log_level == "INFO"

    def test_log_level_all_valid_values(self) -> None:
        """Test all valid log level values."""
        for level in ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]:
            config = SolverConfig(log_level=level)
            assert config.log_level == level

    def test_confidence_thresholds_must_be_in_range(self) -> None:
        """Test that confidence thresholds must be between 0 and 1."""
        with pytest.raises(ValueError, match="conf_threshold must be between 0.0 and 1.0"):
            SolverConfig(conf_threshold=1.5)
        
        with pytest.raises(ValueError, match="conf_threshold must be between 0.0 and 1.0"):
            SolverConfig(conf_threshold=-0.1)
        
        with pytest.raises(ValueError, match="min_confidence_threshold must be between"):
            SolverConfig(min_confidence_threshold=2.0)
        
        with pytest.raises(ValueError, match="fourth_cell_threshold must be between"):
            SolverConfig(fourth_cell_threshold=-0.5)
        
        with pytest.raises(ValueError, match="detection_conf_threshold must be between"):
            SolverConfig(detection_conf_threshold=1.1)

    def test_confidence_thresholds_valid_edge_values(self) -> None:
        """Test that confidence thresholds accept edge values 0.0 and 1.0."""
        config = SolverConfig(conf_threshold=0.0)
        assert config.conf_threshold == 0.0
        
        config = SolverConfig(conf_threshold=1.0)
        assert config.conf_threshold == 1.0

    def test_default_timeout_must_be_positive(self) -> None:
        """Test that default_timeout must be positive."""
        with pytest.raises(ValueError, match="default_timeout must be positive"):
            SolverConfig(default_timeout=0)

    def test_human_delay_mean_must_be_non_negative(self) -> None:
        """Test that human_delay_mean must be non-negative."""
        with pytest.raises(ValueError, match="human_delay_mean must be non-negative"):
            SolverConfig(human_delay_mean=-0.1)
        
        config = SolverConfig(human_delay_mean=0)
        assert config.human_delay_mean == 0

    def test_human_delay_sigma_must_be_non_negative(self) -> None:
        """Test that human_delay_sigma must be non-negative."""
        with pytest.raises(ValueError, match="human_delay_sigma must be non-negative"):
            SolverConfig(human_delay_sigma=-0.1)

    def test_image_download_retries_must_be_non_negative(self) -> None:
        """Test that image_download_retries must be non-negative."""
        with pytest.raises(ValueError, match="image_download_retries must be non-negative"):
            SolverConfig(image_download_retries=-1)
        
        config = SolverConfig(image_download_retries=0)
        assert config.image_download_retries == 0

    def test_image_download_retry_delay_must_be_non_negative(self) -> None:
        """Test that image_download_retry_delay must be non-negative."""
        with pytest.raises(ValueError, match="image_download_retry_delay must be non-negative"):
            SolverConfig(image_download_retry_delay=-1.0)

    def test_download_dir_default_is_tmp(self) -> None:
        """Test that download_dir defaults to 'tmp'."""
        config = SolverConfig()
        assert config.download_dir == Path("tmp")

    def test_custom_download_dir(self) -> None:
        """Test custom download directory."""
        config = SolverConfig(download_dir=Path("custom_dir"))
        assert config.download_dir == Path("custom_dir")

    def test_all_configurable_thresholds(self) -> None:
        """Test that all thresholds are properly set."""
        config = SolverConfig(
            conf_threshold=0.5,
            min_confidence_threshold=0.1,
            fourth_cell_threshold=0.6,
            detection_conf_threshold=0.4,
        )
        assert config.conf_threshold == 0.5
        assert config.min_confidence_threshold == 0.1
        assert config.fourth_cell_threshold == 0.6
        assert config.detection_conf_threshold == 0.4


class TestProxyValidation:
    """Tests for proxy URL validation."""

    def test_valid_http_proxy(self) -> None:
        """Test valid HTTP proxy URL."""
        config = SolverConfig(proxy="http://proxy.example.com:8080")
        assert config.proxy == "http://proxy.example.com:8080"

    def test_valid_https_proxy(self) -> None:
        """Test valid HTTPS proxy URL."""
        config = SolverConfig(proxy="https://proxy.example.com:443")
        assert config.proxy == "https://proxy.example.com:443"

    def test_valid_socks5_proxy(self) -> None:
        """Test valid SOCKS5 proxy URL."""
        config = SolverConfig(proxy="socks5://proxy.example.com:1080")
        assert config.proxy == "socks5://proxy.example.com:1080"

    def test_valid_socks4_proxy(self) -> None:
        """Test valid SOCKS4 proxy URL."""
        config = SolverConfig(proxy="socks4://proxy.example.com:1080")
        assert config.proxy == "socks4://proxy.example.com:1080"

    def test_valid_proxy_with_auth(self) -> None:
        """Test valid proxy URL with authentication."""
        config = SolverConfig(proxy="http://user:pass@proxy.example.com:8080")
        assert config.proxy == "http://user:pass@proxy.example.com:8080"

    def test_valid_socks5_proxy_with_auth(self) -> None:
        """Test valid SOCKS5 proxy URL with authentication."""
        config = SolverConfig(proxy="socks5://user:password123@proxy.example.com:1080")
        assert config.proxy == "socks5://user:password123@proxy.example.com:1080"

    def test_none_proxy_is_valid(self) -> None:
        """Test that None proxy is valid."""
        config = SolverConfig(proxy=None)
        assert config.proxy is None

    def test_invalid_proxy_missing_protocol(self) -> None:
        """Test that proxy without protocol raises error."""
        with pytest.raises(ValueError, match="Invalid proxy URL format"):
            SolverConfig(proxy="proxy.example.com:8080")

    def test_invalid_proxy_missing_port(self) -> None:
        """Test that proxy without port raises error."""
        with pytest.raises(ValueError, match="Invalid proxy URL format"):
            SolverConfig(proxy="http://proxy.example.com")

    def test_invalid_proxy_unsupported_protocol(self) -> None:
        """Test that proxy with unsupported protocol raises error."""
        with pytest.raises(ValueError, match="Invalid proxy URL format"):
            SolverConfig(proxy="ftp://proxy.example.com:21")

    def test_invalid_proxy_port_out_of_range(self) -> None:
        """Test that proxy with invalid port raises error."""
        with pytest.raises(ValueError, match="Invalid proxy port"):
            SolverConfig(proxy="http://proxy.example.com:70000")

    def test_invalid_proxy_malformed(self) -> None:
        """Test that malformed proxy URL raises error."""
        with pytest.raises(ValueError, match="Invalid proxy URL format"):
            SolverConfig(proxy="not-a-valid-proxy")
