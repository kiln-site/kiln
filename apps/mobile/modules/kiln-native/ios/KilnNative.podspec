Pod::Spec.new do |s|
  s.name           = 'KilnNative'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for Kiln mobile.'
  s.description    = 'The floating navigation bar and other UIKit-backed chrome.'
  s.author         = 'Kiln'
  s.homepage       = 'https://github.com/kiln-site/kiln'
  s.platforms      = { :ios => '27.0' }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift}'
end
