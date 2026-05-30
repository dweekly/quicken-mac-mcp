class Qmac < Formula
  desc "Self-documenting CLI and MCP server for Quicken For Mac"
  homepage "https://dweekly.github.io/quicken-mac-mcp/"
  url "https://registry.npmjs.org/quicken-mac-mcp/-/quicken-mac-mcp-1.5.0.tgz"
  sha256 "1b2abab2869811c431630378aea96b21de42b004b9ae2654f238c75414171f7d"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Simple sanity check
    system "#{bin}/qmac", "--version"
    system "#{bin}/quicken-mac-mcp", "--version"
  end
end
