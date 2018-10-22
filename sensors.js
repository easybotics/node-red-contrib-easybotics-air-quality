var SerialPort 	= require('serialport');
var gpio     	= require('rpi-gpio');





module.exports = function(RED) {

	var port; 

	function PMSChecksum (buffer) 
	{
		var output = 0; 

		for(var i = 0; i < 30; i++)
		{
			output += buffer.readUInt8(i);
			output = output & 65535;
		}

		return output; 
	}

	function C02Checksum (buffer) 
	{
		const overFlow = function (i)
		{
			if(i >= 0 && i <= 256) return i;
			if(i > 256) return overFlow( i - 256);
			if(i < 0)   return overFlow(256 - (-1 * i));
		}

		var output = 0; 

		for(var i = 0; i < 8; i++)
			output = overFlow(output + buffer.readUInt8(i));

		output = overFlow( 255 - output);

		return output; 
	}
			



	function Handle (config) 
	{
		RED.nodes.createNode(this, config);
		const node = this;
		const C02Command = Buffer.from([255, 1, 134, 0, 0, 0, 0, 0, 121]);
		const C02CommandZero = Buffer.from([255, 1, 135, 0, 0, 0, 0, 0, 120]); 

		node.log("command checksum:");
		node.log( C02Checksum( C02Command));

		var zeroNext = false;
		node.lastC02 = undefined; 
		node.lastPMS = undefined;

		node.zeroC02 = function ()
		{

			zeroNext = true;
		}

		if(!port)
		{
			port = new SerialPort('/dev/serial0', { baudRate: 9600});
		}

		function ghettoFlush ()
		{
			if (! (port.read(1))) return 0;

			var i = 1000;
			var inBuf = port.read(i);
			while (!inBuf)
				inBuf = port.read(i--);

			return 1000 - i;
		}

	function parseC02 (buffer) 
	{

		if(parseInt(C02Checksum(buffer)) != parseInt(buffer.readUInt8(8)) )
		{
			node.log("dumped c02 due to checksum");
			return undefined;
		}

		return parseInt( buffer.readUInt8(2) * 256 + buffer.readUInt8(3));
	}

		function muxA (callback)
		{
			gpio.write(35, 0, function()
				{
					gpio.write(22, 0, function() 
					{
						port.flush(callback);
					});
				});
		};

		function muxB (callback)
		{
				gpio.write(35, 1, function()
				{
					gpio.write(22, 0, function()
						{
							port.flush(callback);
						});
				});
		};

		function parsePMS (buffer)
		{
				const calcCheck =  PMSChecksum(buffer); 
				const readCheck = (buffer.readUInt8(30) * 256  + buffer.readUInt8(31));

				if(calcCheck == readCheck);
				{
					node.log("calcCheck: " + calcCheck);
					node.log("realCheck: " + readCheck);
					return { pm10: buffer.readUInt8(10) * 256 + buffer.readUInt8(11), 
							 pm25: buffer.readUInt8(12) * 256 + buffer.readUInt8(13), 
							 pm100: buffer.readUInt8(14) * 256 + buffer.readUInt8(15),}
				}

				return undefined; 

		}

		function readPMS () 
		{
			const inBuf = port.read(32);
			if(!inBuf)	return node.lastPMS;

			var last = 66;
			var count = -1;
			for(const b of inBuf)
			{
				if(last == 66 && b == 77) break;
				count++;
				last = b;
			}

			if(count == 0) { return parsePMS(inBuf);};

			const secondary = port.read(32 - count);
			try 
			{
				const fRead = Buffer.concat( [inBuf.slice(count, 32), secondary.slice(0, count)]);
				node.log("tried concatting..");

				return parsePMS(fRead);
			}
			catch (e) 
			{
				node.log("caught from concatting though");
				node.log(e);
				return undefined;
			};


		}


		function readC02 ()
		{
			var inBuf = port.read(9);
			if(!inBuf) return undefined;

			return parseC02(inBuf);
		}

		function callBack( up = true, count = 0, delay = 2000) 
		{
			if(up)
			{
				muxA(function()
				{
					node.log("mux a");
					setTimeout(function()
					{
						node.log("reading pms");
						const out = readPMS();
						node.lastPMS = out;

						callBack(!up, count + 1, delay);

					}, delay);
				});
			}
			else
			{
				muxB(function()
					{
						node.log("flushed: " + ghettoFlush());
						if(zeroNext) 
						{
							node.log("zeroing");
							port.write(C02CommandZero);
							zeroNext = false; 
						}

						port.write(C02Command);
						node.log("wrote c02 command");
						setTimeout(function()
						{
							port.drain(
							function() {
								node.log("reading c02");
								node.lastC02 = readC02();
							});

							callBack(!up, count + 1, delay);
						}, delay); 

					});
			}
		}

		gpio.setup(22, gpio.DIR_OUT, function()
			{

			gpio.setup(35, gpio.DIR_OUT, function() 
				{

				 callBack();

				});
			}); 



		};




	function C02Sensor (config) 
	{
		RED.nodes.createNode(this, config);
		const node = this;

		node.handle = RED.nodes.getNode(config.handle);
	

		function outRecall ()
		{
			if(node.handle.lastC02 != undefined)
			node.send( {payload: node.handle.lastC02});

			setTimeout(function()
				{
					outRecall();

				}, 2000);
		}

		node.on('input', function(msg) 
		{
			if(msg.topic == "zero")
			{
				node.handle.zeroC02();
			}
		});



		outRecall();

	}

	function PMSSensor (config)
	{
		RED.nodes.createNode(this, config); 
		const node = this;

		node.handle = RED.nodes.getNode(config.handle); 

		function outRecall ()
		{

			setTimeout(function()
				{
					outRecall();

				}, 2000);

			if(node.handle.lastPMS)
			node.send([ {payload: node.handle.lastPMS.pm10}, {payload: node.handle.lastPMS.pm25}, {payload: node.handle.lastPMS.pm100}]);
		}

		outRecall();
	}




	RED.nodes.registerType("mux-handle", Handle);
	RED.nodes.registerType("mux-c02-read", C02Sensor);
	RED.nodes.registerType("mux-PMS-read", PMSSensor);
}
