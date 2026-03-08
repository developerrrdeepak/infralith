
'use client';
import { Building2, Linkedin, Twitter, Github } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="border-t pt-10 mt-10">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-sm">
          {/* Column 1: Brand */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 font-headline font-bold tracking-tight text-xl">
              <Building2 className="h-5 w-5 text-primary" />
              <span className="text-foreground">Infra</span>
              <span className="text-primary">lith</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              AI-Powered Construction Intelligence Platform for pre-construction blueprint evaluation.
            </p>
            <div className="flex space-x-4">
              <a href="#" className="text-muted-foreground hover:text-primary"><Twitter className="h-4 w-4" /></a>
              <a href="#" className="text-muted-foreground hover:text-primary"><Linkedin className="h-4 w-4" /></a>
              <a href="#" className="text-muted-foreground hover:text-primary"><Github className="h-4 w-4" /></a>
            </div>
          </div>

          {/* Column 2: Platform */}
          <div className="space-y-2">
            <h3 className="font-semibold text-foreground">Platform</h3>
            <a href="#" className="block text-muted-foreground hover:text-primary">Blueprint Analysis</a>
            <a href="#" className="block text-muted-foreground hover:text-primary">Compliance Engine</a>
            <a href="#" className="block text-muted-foreground hover:text-primary">Risk Assessment</a>
            <a href="#" className="block text-muted-foreground hover:text-primary">Cost Prediction</a>
          </div>

          {/* Column 3: Resources */}
          <div className="space-y-2">
            <h3 className="font-semibold text-foreground">Resources</h3>
            <a href="#" className="block text-muted-foreground hover:text-primary">Documentation</a>
            <a href="#" className="block text-muted-foreground hover:text-primary">API Reference</a>
            <a href="#" className="block text-muted-foreground hover:text-primary">Best Practices</a>
          </div>

          {/* Column 4: Legal */}
          <div className="space-y-2">
            <h3 className="font-semibold text-foreground">Company</h3>
            <a href="#" className="block text-muted-foreground hover:text-primary">About</a>
            <a href="#" className="block text-muted-foreground hover:text-primary">Privacy Policy</a>
            <a href="#" className="block text-muted-foreground hover:text-primary">Terms of Service</a>
            <a href="#" className="block text-muted-foreground hover:text-primary">Support</a>
          </div>
        </div>

        <div className="text-center text-xs text-muted-foreground mt-10 py-4 border-t">
          © {new Date().getFullYear()} Infralith. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
