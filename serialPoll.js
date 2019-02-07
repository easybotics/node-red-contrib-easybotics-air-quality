var exports = module.exports = {};
var {execSync}  = require('child_process');

exports.hardwareSerial = function ()
{
	try
	{
		let stdout = execSync("cat /proc/cpuinfo | grep erial");
		return stdout.toString().split(' ')[1].split('\n')[0];
	}
	catch(e) { return undefined};
}

exports.shortSerial = function ()
{
	const hash = function (str)
	{
		var acc = 0;
		for(const c of str)
		{
			if(c == '0') continue;
			acc += c.charCodeAt(0);
		}

		return acc;
	}

	const hard = exports.hardwareSerial(); 
	
	if(!hard) return hard; 
	return hash(hard.slice(0,8)) + hard.slice(8);
}

